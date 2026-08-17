/**
 * Per-page network and console capture. Ring buffers fill from the page's
 * CDP session; query tools filter on read. Response bodies are fetched on
 * demand (opt-in per call) and never redacted — the secrets policy is that
 * token material stays inside evaluate/script scope.
 */

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

interface PageBuffers {
  network: NetworkRecord[];
  console: ConsoleRecord[];
  seq: number;
}

const buffers = new Map<Page, PageBuffers>();
const attached = new WeakSet<Page>();

const buffersFor = (page: Page): PageBuffers => {
  let b = buffers.get(page);
  if (!b) {
    b = { network: [], console: [], seq: 0 };
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
  });
  client.on("Network.responseReceived", (event) => {
    const rec = pending.get(event.requestId);
    if (rec) rec.status = event.response.status;
  });
  client.on("Network.loadingFailed", (event) => {
    const rec = pending.get(event.requestId);
    if (rec && !rec.status) rec.failed = event.errorText;
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
