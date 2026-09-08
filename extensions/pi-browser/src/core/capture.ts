/**
 * Per-page network and console capture. Ring buffers fill from the page's
 * CDP session; query tools filter on read. Response bodies are fetched on
 * demand (opt-in per call) and never redacted — the secrets policy is that
 * token material stays inside evaluate/script scope.
 *
 * A parallel per-page "exchanges" buffer retains full request/response pairs
 * (request headers/postData, response status/headers/body/contentType) for
 * the capture-export bridge. Bodies are fetched eagerly at response time so
 * they stay available; capture-export returns only aggregate metadata, so
 * the buffer never leaks credentials through query tools.
 */

import { matchesDomainGlob, type CapturedExchange } from "@apitap/core";
import type { CDPSession, Page } from "puppeteer-core";

export interface NetworkRecord {
  seq: number;
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  failed?: string;
  time: number;
}

export interface ConsoleRecord {
  seq: number;
  level: string;
  text: string;
  time: number;
}

const MAX_RECORDS = 500;
const MAX_BODY_CHARS = 20_000;
const MAX_TEXT_ARG = 500;
/** Cap for eagerly-retained exchange bodies, bounding daemon memory. */
const MAX_EXCHANGE_BODY_CHARS = 100_000;

/** A fully shaped captured request/response pair, plus buffer bookkeeping. */
export interface StoredExchange extends CapturedExchange {
  requestId: string;
  seq: number;
}

interface PageBuffers {
  network: NetworkRecord[];
  exchanges: StoredExchange[];
  console: ConsoleRecord[];
  seq: number;
}

const buffers = new Map<Page, PageBuffers>();
const attached = new WeakSet<Page>();

const buffersFor = (page: Page): PageBuffers => {
  let b = buffers.get(page);
  if (!b) {
    b = { network: [], exchanges: [], console: [], seq: 0 };
    buffers.set(page, b);
  }
  return b;
};

const push = <T>(list: T[], item: T): void => {
  list.push(item);
  if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
};

/** Attach capture domains once per owned page. Idempotent. */
export const attachCapture = async (
  page: Page,
  client: CDPSession,
): Promise<void> => {
  if (attached.has(page)) return;
  attached.add(page);
  const b = buffersFor(page);

  await client.send("Network.enable");
  await client.send("Runtime.enable");

  const pending = new Map<string, NetworkRecord>();
  const pendingExchanges = new Map<string, StoredExchange>();
  // The pending map is keyed by every requestId ever seen; drop entries
  // whose exchange has already been evicted from the ring buffer.
  const prunePendingExchanges = (): void => {
    if (pendingExchanges.size <= MAX_RECORDS) return;
    const alive = new Set(b.exchanges.map((e) => e.requestId));
    for (const [id] of pendingExchanges) {
      if (!alive.has(id)) pendingExchanges.delete(id);
    }
  };

  const mergeHeaders = (
    exchange: StoredExchange | undefined,
    headers: Record<string, string> | undefined,
    into: "request" | "response",
  ): void => {
    if (!exchange || !headers) return;
    for (const [name, value] of Object.entries(headers)) {
      exchange[into].headers[name] = value;
    }
  };

  client.on("Network.requestWillBeSent", (event) => {
    const rec: NetworkRecord = {
      seq: ++b.seq,
      requestId: event.requestId,
      url: event.request.url,
      method: event.request.method,
      resourceType: event.type ?? "Other",
      time: Date.now(),
    };
    pending.set(event.requestId, rec);
    push(b.network, rec);

    const exchange: StoredExchange = {
      seq: rec.seq,
      requestId: event.requestId,
      request: {
        url: event.request.url,
        method: event.request.method,
        headers: { ...(event.request.headers ?? {}) },
        ...(event.request.postData
          ? {
              postData: event.request.postData.slice(
                0,
                MAX_EXCHANGE_BODY_CHARS,
              ),
            }
          : {}),
      },
      response: { status: 0, headers: {}, body: "", contentType: "" },
      timestamp: new Date(rec.time).toISOString(),
    };
    pendingExchanges.set(event.requestId, exchange);
    push(b.exchanges, exchange);
    prunePendingExchanges();
  });
  client.on("Network.requestWillBeSentExtraInfo", (event) => {
    mergeHeaders(
      pendingExchanges.get(event.requestId),
      event.headers,
      "request",
    );
  });
  client.on("Network.responseReceived", (event) => {
    const rec = pending.get(event.requestId);
    if (rec) rec.status = event.response.status;
    const ex = pendingExchanges.get(event.requestId);
    if (!ex) return;
    ex.response.status = event.response.status;
    ex.response.contentType = event.response.mimeType ?? "";
    mergeHeaders(ex, event.response.headers, "response");
    // Fetch the body now; getResponseBody is only available for a limited
    // window after the response, so lazy export-time fetches would miss it.
    void (async () => {
      try {
        const { body, base64Encoded } = await client.send(
          "Network.getResponseBody",
          { requestId: event.requestId },
        );
        const text = base64Encoded
          ? Buffer.from(body, "base64").toString("utf8")
          : body;
        ex.response.body = text.slice(0, MAX_EXCHANGE_BODY_CHARS);
      } catch {
        // body unavailable (streamed/media/redirect); keep what we have
      }
    })();
  });
  client.on("Network.responseReceivedExtraInfo", (event) => {
    mergeHeaders(
      pendingExchanges.get(event.requestId),
      event.headers,
      "response",
    );
  });
  client.on("Network.loadingFailed", (event) => {
    const rec = pending.get(event.requestId);
    if (rec && !rec.status) rec.failed = event.errorText;
    // The status-0 exchange stays in the ring; export filters it out.
  });

  client.on("Runtime.consoleAPICalled", (event) => {
    const text = event.args
      .map((arg) => {
        if (typeof arg.value === "string")
          return arg.value.slice(0, MAX_TEXT_ARG);
        if (arg.value !== undefined)
          return JSON.stringify(arg.value)?.slice(0, MAX_TEXT_ARG) ?? "";
        return (arg.description ?? arg.type).slice(0, MAX_TEXT_ARG);
      })
      .filter(Boolean)
      .join(" ");
    push(b.console, {
      seq: ++b.seq,
      level: event.type,
      text,
      time: Date.now(),
    });
  });
  client.on("Runtime.exceptionThrown", (event) => {
    const desc =
      event.exceptionDetails.exception?.description ??
      event.exceptionDetails.text;
    push(b.console, {
      seq: ++b.seq,
      level: "error",
      text: desc.split("\n")[0] ?? desc,
      time: Date.now(),
    });
  });

  page.once("close", () => buffers.delete(page));
};

export interface NetworkQuery {
  urlPattern?: string | undefined;
  method?: string | undefined;
  minStatus?: number | undefined;
  maxStatus?: number | undefined;
  sinceSeq?: number | undefined;
  limit?: number | undefined;
  includeResponseBodies?: boolean | undefined;
}

export const queryNetwork = async (
  client: CDPSession,
  page: Page,
  q: NetworkQuery,
): Promise<Array<NetworkRecord & { responseBody?: string }>> => {
  const b = buffersFor(page);
  const method = q.method?.toUpperCase();
  let out = b.network.filter((r) => {
    if (q.sinceSeq !== undefined && r.seq <= q.sinceSeq) return false;
    if (q.urlPattern && !r.url.includes(q.urlPattern)) return false;
    if (method && r.method !== method) return false;
    if (
      q.minStatus !== undefined &&
      (r.status === undefined || r.status < q.minStatus)
    )
      return false;
    if (
      q.maxStatus !== undefined &&
      (r.status === undefined || r.status > q.maxStatus)
    )
      return false;
    return true;
  });
  out = out.slice(-(q.limit ?? 50));
  if (!q.includeResponseBodies) return out;
  return Promise.all(
    out.map(async (r) => {
      try {
        const { body, base64Encoded } = await client.send(
          "Network.getResponseBody",
          { requestId: r.requestId },
        );
        const text = base64Encoded
          ? Buffer.from(body, "base64").toString("utf8")
          : body;
        return { ...r, responseBody: text.slice(0, MAX_BODY_CHARS) };
      } catch {
        return r;
      }
    }),
  );
};

export interface ConsoleQuery {
  levels?: string[] | undefined;
  sinceSeq?: number | undefined;
  limit?: number | undefined;
}

export const queryConsole = (
  page: Page,
  q: ConsoleQuery,
): { records: ConsoleRecord[]; nextCursor: number } => {
  const b = buffersFor(page);
  const levels = q.levels?.length ? new Set(q.levels) : null;
  const out = b.console.filter((r) => {
    if (q.sinceSeq !== undefined && r.seq <= q.sinceSeq) return false;
    if (levels && !levels.has(r.level)) return false;
    return true;
  });
  return { records: out.slice(-(q.limit ?? 50)), nextCursor: b.seq };
};

export const consoleSeq = (page: Page): number => buffersFor(page).seq;

// ---------------------------------------------------------------- export bridge

export interface CaptureExportFilter {
  /** Exact domains and `*.example.com` style patterns; empty = no filter. */
  domains?: string[] | undefined;
  /** Only exchanges with seq strictly greater than this. */
  sinceSeq?: number | undefined;
  /** Only exchanges whose response status is >= this. */
  minStatus?: number | undefined;
}

/** Extract a lowercase hostname from a URL, or "" when unparsable. */
export const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** True when a hostname matches any pattern (empty pattern list = no filter). */
export const matchesCapturedDomains = (
  hostname: string,
  patterns: string[],
): boolean =>
  matchesDomainGlob(
    hostname.toLowerCase(),
    patterns.map((p) => p.toLowerCase()),
  );

/**
 * Pure filter over captured exchanges: drops incomplete responses (no
 * received status), honors sinceSeq / minStatus, and restricts to hosts
 * matching the domain patterns when any are given.
 */
export const filterCapturedExchanges = <
  E extends {
    seq: number;
    request: { url: string };
    response: { status: number };
  },
>(
  exchanges: E[],
  filter: CaptureExportFilter,
): E[] =>
  exchanges.filter((e) => {
    if (e.response.status <= 0) return false;
    if (filter.sinceSeq !== undefined && e.seq <= filter.sinceSeq) return false;
    if (filter.minStatus !== undefined && e.response.status < filter.minStatus)
      return false;
    if (filter.domains !== undefined && filter.domains.length > 0) {
      const host = hostnameOf(e.request.url);
      if (!host || !matchesCapturedDomains(host, filter.domains)) return false;
    }
    return true;
  });

/** Snapshot of the page's captured exchanges, filtered for export. */
export const exportCaptured = (
  page: Page,
  filter?: CaptureExportFilter,
): StoredExchange[] =>
  filterCapturedExchanges(buffersFor(page).exchanges, filter ?? {});
