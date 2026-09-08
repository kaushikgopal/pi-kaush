/**
 * capture-export bridge: turn the per-page captured exchanges into signed
 * ApiTap skill files plus encrypted auth storage. Runs daemon-side against
 * the daemon's own CDP connection (bodies were eagerly captured there).
 * Returns only aggregate metadata — never headers, cookies, tokens, post
 * bodies, or response bodies.
 */

import {
  AuthManager,
  getMachineId,
  importSkillFile,
  parseDomainPatterns,
  SkillGenerator,
  type CapturedExchange,
  type SkillEndpoint,
} from "@apitap/core";
import { deduplicateAuth } from "@apitap/core/dist/skill/generator.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import {
  exportCaptured,
  hostnameOf,
  type CaptureExportFilter,
} from "./capture.ts";

export interface CaptureExportParams {
  /** Named session page; falls back to the current page when omitted. */
  session?: string | undefined;
  /** Comma-separated domain patterns (exact or `*.example.com` style). */
  domain?: string | undefined;
  sinceSeq?: number | undefined;
  minStatus?: number | undefined;
}

export interface CaptureExportEndpoint {
  id: string;
  method: string;
  path: string;
}

export interface CaptureExportDomain {
  domain: string;
  skillPath: string;
  endpoints: CaptureExportEndpoint[];
  captureCount: number;
}

/** Auth metadata only — credential values never leave the daemon. */
export interface CaptureExportStoredAuth {
  domain: string;
  type: string;
  header: string;
}

export interface CaptureExportResult {
  domains: CaptureExportDomain[];
  authStored: CaptureExportStoredAuth[];
  errors: string[];
  totalCaptured: number;
}

const apitapDir = (): string =>
  process.env["APITAP_DIR"] ?? join(homedir(), ".apitap");

/** Resolve CLI/params into daemon filters and run the export. */
export const runCaptureExport = async (
  page: Page,
  params: CaptureExportParams,
): Promise<CaptureExportResult> => {
  const filters: CaptureExportFilter = {
    domains: parseDomainPatterns(params.domain).map((d) => d.toLowerCase()),
    sinceSeq: params.sinceSeq,
    minStatus: params.minStatus,
  };
  return captureExportForPage(page, filters);
};

/** Remove HTTP/2 pseudo-headers that the Fetch Headers API rejects. */
export const stripPseudoHeaders = (
  headers: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => !name.startsWith(":")),
  );
/** Marker used only while ApiTap 2.2.2 recognizes persisted GraphQL bodies. */
const PERSISTED_GRAPHQL_QUERY_MARKER =
  "query __ApiTapPersistedQueryPlaceholder";

/** Return the persisted GraphQL operation name, if the body has one. */
export const persistedGraphQLOperationName = (
  postData: string | undefined,
 ): string | null => {
  if (!postData) return null;
  try {
    const parsed: unknown = JSON.parse(postData);
    if (!parsed || typeof parsed !== "object") return null;
    const body = parsed as Record<string, unknown>;
    const extensions = body.extensions;
    const persistedQuery =
      extensions &&
      typeof extensions === "object" &&
      "persistedQuery" in extensions;
    if (
      typeof body.operationName !== "string" ||
      !persistedQuery ||
      typeof body.query === "string"
    ) {
      return null;
    }
    return body.operationName;
  } catch {
    return null;
  }
};

/**
 * Make a persisted GraphQL request visible to the 2.2.2 generator without
 * changing the body that will be replayed. The marker is removed below after
 * endpoint generation, so it never reaches the skill file or wire.
 */
export const markPersistedGraphQLExchange = (
  exchange: CapturedExchange,
 ): CapturedExchange => {
  if (!persistedGraphQLOperationName(exchange.request.postData)) {
    return exchange;
  }
  const body = JSON.parse(exchange.request.postData as string) as Record<
    string,
    unknown
  >;
  return {
    ...exchange,
    request: {
      ...exchange.request,
      postData: JSON.stringify({
        ...body,
        query: PERSISTED_GRAPHQL_QUERY_MARKER,
      }),
    },
  };
};

/** Remove the generator-only persisted GraphQL marker from a body template. */
export const restorePersistedGraphQLBody = (
  endpoint: SkillEndpoint,
 ): SkillEndpoint => {
  const requestBody = endpoint.requestBody;
  if (!requestBody) return endpoint;

  const restore = (template: unknown): unknown => {
    let body: Record<string, unknown>;
    let wasString = false;
    if (typeof template === "string") {
      try {
        const parsed: unknown = JSON.parse(template);
        if (!parsed || typeof parsed !== "object") return template;
        body = parsed as Record<string, unknown>;
        wasString = true;
      } catch {
        return template;
      }
    } else if (template && typeof template === "object") {
      body = { ...(template as Record<string, unknown>) };
    } else {
      return template;
    }
    if (body.query !== PERSISTED_GRAPHQL_QUERY_MARKER) return template;
    const { query: _query, ...withoutMarker } = body;
    return wasString ? JSON.stringify(withoutMarker) : withoutMarker;
  };

  return {
    ...endpoint,
    requestBody: {
      ...requestBody,
      template: restore(requestBody.template) as typeof requestBody.template,
    },
  };
};
export const captureExportForPage = async (
  page: Page,
  filters: CaptureExportFilter,
): Promise<CaptureExportResult> => {
  const exchanges = exportCaptured(page, filters);

  // CDP can expose HTTP/2 pseudo-headers such as :authority. They are valid
  // on the wire but invalid to the Fetch Headers API used by ApiTap replay.
  const sanitizeExchange = (ex: CapturedExchange): CapturedExchange => ({
    request: {
      ...ex.request,
      headers: stripPseudoHeaders(ex.request.headers),
    },
    response: {
      ...ex.response,
      headers: stripPseudoHeaders(ex.response.headers),
    },
    timestamp: ex.timestamp,
  });

  // Group the surviving exchanges by hostname; each group becomes one skill.
  const byHost = new Map<string, CapturedExchange[]>();
  for (const ex of exchanges) {
    const host = hostnameOf(ex.request.url);
    if (!host) continue;
    const group = byHost.get(host) ?? [];
    group.push(sanitizeExchange(ex));
    byHost.set(host, group);
  }

  const dir = apitapDir();
  const skillsDir = join(dir, "skills");
  const machineId = await getMachineId();
  const authManager = new AuthManager(dir, machineId);

  const result: CaptureExportResult = {
    domains: [],
    authStored: [],
    errors: [],
    totalCaptured: 0,
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-browser-capture-export-"));
  try {
    for (const [domain, group] of byHost) {
      try {
        const gen = new SkillGenerator({ scrub: true, enablePreview: false });
        // Prefer the latest captured body for duplicate operations. This lets
        // a workflow's final filter or time-window selection drive replay.
        for (const ex of [...group].reverse()) {
          gen.addExchange(markPersistedGraphQLExchange(ex));
        }
        const skill = gen.toSkillFile(domain);
        skill.endpoints = skill.endpoints.map(restorePersistedGraphQLBody);

        // Unsigned intermediate file; ApiTap re-signs it with the machine's
        // own local key during the import below.
        const tmpPath = join(tmpDir, `${domain}.json`);
        writeFileSync(tmpPath, JSON.stringify(skill, null, 2) + "\n", {
          mode: 0o600,
        });
        const imported = await importSkillFile(tmpPath, skillsDir);
        if (!imported.success) {
          result.errors.push(
            `${domain}: ${imported.reason ?? "import failed"}`,
          );
          continue;
        }

        // Deduplicate auth: the primary (bearer > api-key > custom)
        // credential plus any unique extra auth headers as sidecars.
        const auth = deduplicateAuth(gen.getExtractedAuth());
        if (auth) {
          await authManager.store(domain, auth);
          result.authStored.push({
            domain,
            type: auth.type,
            header: auth.header,
          });
        }
        // OAuth sidecars are written after the primary credential because
        // AuthManager.store() replaces the whole record.
        const clientSecret = gen.getOAuthClientSecret();
        const refreshToken = gen.getOAuthRefreshToken();
        if (clientSecret !== undefined || refreshToken !== undefined) {
          const oauth: { refreshToken?: string; clientSecret?: string } = {};
          if (clientSecret !== undefined) oauth.clientSecret = clientSecret;
          if (refreshToken !== undefined) oauth.refreshToken = refreshToken;
          await authManager.storeOAuthCredentials(domain, oauth);
        }

        result.domains.push({
          domain,
          skillPath: imported.skillFile ?? join(skillsDir, `${domain}.json`),
          endpoints: skill.endpoints.map((e) => ({
            id: e.id,
            method: e.method,
            path: e.path,
          })),
          captureCount: group.length,
        });
        result.totalCaptured += group.length;
      } catch (error) {
        result.errors.push(
          `${domain}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return result;
};
