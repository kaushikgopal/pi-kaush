import type {
  BrowserSession,
  FirefoxBrowserFailure,
  FirefoxBrowserResult,
  TabInfo,
} from "./browser-types.js";

export type FirefoxSnapshotInput = {
  session: string;
  mode: "full" | "scoped" | "text";
  ref?: string;
  depth?: number;
  maxBytes?: number;
  noText?: boolean;
};
export type FirefoxSnapshot = {
  mode: "full" | "scoped" | "text";
  title: string;
  text: string;
  generation: string | null;
  refs: number;
  truncated: boolean;
  maxBytes: number;
};
export type FirefoxLocateInput = {
  session: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  exact?: boolean;
};
export type FirefoxLocatedElement = {
  ref: string;
  role: string;
  name: string | null;
};
export type FirefoxActInput = {
  session: string;
  action: "click" | "fill" | "key" | "scroll" | "select";
  ref?: string;
  locate?: Omit<FirefoxLocateInput, "session">;
  value?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  noDiff?: boolean;
};
export type FirefoxActionDiff = {
  added: string[];
  removed: string[];
  truncated: boolean;
};
export type FirefoxActionResult = {
  action: FirefoxActInput["action"];
  ref: string | null;
  diff: FirefoxActionDiff | null;
};
export type FirefoxWaitInput = {
  session: string;
  ref?: string;
  text?: string;
  url?: string;
  timeoutMs?: number;
};
export type FirefoxWaitResult = {
  matched: boolean;
  elapsedMs: number;
};
export type FirefoxNetworkInput = {
  session: string;
  origin?: string;
  method?: string;
  type?: string;
  status?: number;
  urlsOnly?: boolean;
  maxEntries?: number;
  cursor?: string;
};
export type FirefoxNetworkEntry = {
  url: string;
  method?: string;
  type?: string;
  status?: number;
};
export type FirefoxNetworkResult = {
  entries: FirefoxNetworkEntry[];
  truncated: boolean;
  retentionMs: 30_000;
  cursor: null;
};
export type FirefoxScreenshotInput = {
  session: string;
  outputPath?: string;
  fullResolution?: boolean;
  focus?: boolean;
};
export type FirefoxScreenshotResult = {
  path: string;
  format: "png";
  resized: boolean;
  resizeWarning?: string;
  selected: true;
  fullPage: false;
};
export type FirefoxReadTextInput = {
  session: string;
  ref?: string;
  maxBytes?: number;
};
export type FirefoxReadText = {
  text: string;
  truncated: boolean;
  maxBytes: number;
};
export type FirefoxSessionSummary = {
  session: string;
  tab: { id: number; windowId: number; url: string };
  containerId: string;
  state: "open" | "closed" | "uncertain" | "confirmation_pending";
  lastUsedAt: string | null;
};
export type FirefoxJsonResult<T> =
  | { ok: true; result: T }
  | FirefoxBrowserFailure;
export type FirefoxSessionCleanupInput = {
  idleAfterMs: number;
  dryRun?: boolean;
};
export type FirefoxSessionCleanupResult = {
  dryRun: boolean;
  eligible: Array<{
    session: string;
    tabId: number;
    url: string;
    containerId: string;
  }>;
  closed: string[];
  failures: Array<{ session: string; code: string }>;
};

export type BrowserFeatureContext = {
  sessions: Map<string, BrowserSession>;
  withSession: <T>(
    session: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<FirefoxBrowserResult<T>>,
    options?: { touch?: boolean },
  ) => Promise<FirefoxBrowserResult<T>>;
  checkedBinding: (
    session: string,
    binding: BrowserSession,
    signal?: AbortSignal,
  ) => Promise<
    { ok: true; tab: TabInfo } | { ok: false; error: FirefoxBrowserFailure }
  >;
  success: <T>(
    session: string,
    tab: TabInfo,
    result: T,
  ) => FirefoxBrowserResult<T>;
  cli: (
    args: readonly string[],
    signal?: AbortSignal,
  ) => Promise<
    | {
        ok: true;
        value: { stdout: string; stderr: string; exitCode: number | null };
      }
    | { ok: false; error: FirefoxBrowserFailure }
  >;
  jsonCommand: (
    args: readonly string[],
    signal?: AbortSignal,
  ) => Promise<
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; error: FirefoxBrowserFailure }
  >;
  listWindows: (
    signal?: AbortSignal,
  ) => Promise<
    | { ok: true; value: Array<{ id: number; private: boolean }> }
    | { ok: false; error: FirefoxBrowserFailure }
  >;
  listTabs: (
    windowId: number,
    signal?: AbortSignal,
  ) => Promise<
    { ok: true; value: TabInfo[] } | { ok: false; error: FirefoxBrowserFailure }
  >;
};
