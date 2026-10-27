import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  boundedInt,
  fail,
  record,
  safeUrl,
  sameUrl,
  validSession,
} from "./browser-types.js";
import {
  fitText,
  matchSnapshotRow,
  parseSnapshot,
  scopedSnapshotText,
  type SnapshotRow,
} from "./browser-snapshot-data.js";
import type {
  BrowserFeatureContext,
  FirefoxActInput,
  FirefoxActionDiff,
  FirefoxActionResult,
  FirefoxJsonResult,
  FirefoxLocateInput,
  FirefoxLocatedElement,
  FirefoxNetworkInput,
  FirefoxNetworkResult,
  FirefoxReadText,
  FirefoxReadTextInput,
  FirefoxScreenshotInput,
  FirefoxScreenshotResult,
  FirefoxSessionCleanupInput,
  FirefoxSessionCleanupResult,
  FirefoxSessionSummary,
  FirefoxSnapshot,
  FirefoxSnapshotInput,
  FirefoxWaitInput,
  FirefoxWaitResult,
} from "./browser-feature-types.js";
import type {
  BrowserSession,
  FirefoxBrowserFailure,
  FirefoxBrowserResult,
  TabInfo,
} from "./browser-types.js";

const MAX_READ_BYTES = 16_000;
const DEFAULT_READ_BYTES = 4_000;
const MAX_REFS = 1_000;
const MAX_GENERATIONS = 8;
const DEFAULT_NETWORK_ENTRIES = 50;
const MAX_NETWORK_ENTRIES = 200;
const MAX_NETWORK_RESULT_BYTES = 12_000;
const MAX_WAIT_MS = 30_000;
const encoder = new TextEncoder();
let nextPublicRef = BigInt(`0x${randomBytes(16).toString("hex")}`);

type RefRecord = {
  publicRef: string;
  backendRef: string;
  generation: string;
  tabId: number;
  windowId: number;
  url: string;
  documentEpoch: number;
  role: string;
  name: string | null;
};
type SnapshotCache = {
  url: string;
  tabId: number;
  windowId: number;
  title: string;
  generation: string;
  documentEpoch: number;
  truncated: boolean;
  rows: SnapshotRow[];
  text: string;
  refs: Map<string, RefRecord>;
};
type SessionCache = {
  records: Map<string, RefRecord>;
  snapshots: SnapshotCache[];
};

export function createBrowserFeatureOperations(context: BrowserFeatureContext) {
  const caches = new Map<string, SessionCache>();
  const { sessions, withSession, checkedBinding, success, cli, jsonCommand } =
    context;

  const getCache = (session: string): SessionCache => {
    let cache = caches.get(session);
    if (!cache) {
      cache = { records: new Map(), snapshots: [] };
      caches.set(session, cache);
    }
    return cache;
  };

  function clearRefs(session: string): void {
    const cache = caches.get(session);
    if (cache) {
      cache.records.clear();
      cache.snapshots = [];
    }
  }

  function syncUrl(session: string, tab: TabInfo): void {
    const cache = caches.get(session);
    if (
      cache &&
      cache.snapshots.some(
        (entry) =>
          !sameUrl(entry.url, tab.url) ||
          entry.documentEpoch !== (sessions.get(session)?.documentEpoch ?? 0),
      )
    )
      clearRefs(session);
  }

  function target(binding: BrowserSession): string[] {
    return [
      "--window",
      `id:${binding.windowId}`,
      "--tab",
      `id:${binding.tabId}`,
    ];
  }

  async function ensureBinding(
    session: string,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; binding: BrowserSession; tab: TabInfo }
    | { ok: false; error: FirefoxBrowserFailure }
  > {
    const binding = sessions.get(session);
    if (!binding)
      return {
        ok: false,
        error: fail(
          "session_not_found",
          "Create this owned session with ensure first.",
        ),
      };
    const checked = await checkedBinding(session, binding, signal);
    if (!checked.ok) return checked;
    if (
      binding.expectedContainerId &&
      binding.expectedContainerId !== checked.tab.cookieStoreId
    )
      return {
        ok: false,
        error: fail(
          "container_conflict",
          "The current tab does not match the session's expected destination container.",
        ),
      };
    syncUrl(session, checked.tab);
    return { ok: true, binding, tab: checked.tab };
  }

  function targetError(
    response: Record<string, unknown>,
    binding: BrowserSession,
  ): FirefoxBrowserFailure | null {
    const targetInfo = response.target;
    if (
      !record(targetInfo) ||
      targetInfo.tabId !== binding.tabId ||
      targetInfo.windowId !== binding.windowId
    )
      return fail(
        "target_mismatch",
        "Firefox returned data for an unverified browser target.",
      );
    if (
      targetInfo.cookieStoreId !== undefined &&
      targetInfo.cookieStoreId !== binding.cookieStoreId
    )
      return fail(
        "container_conflict",
        "Firefox returned data for a different container.",
      );
    return null;
  }

  function outputRef(
    session: string,
    backendRef: string,
    generation: string,
    binding: BrowserSession,
    url: string,
    row?: SnapshotRow,
  ): string {
    const cache = getCache(session);
    const publicRef = `e${nextPublicRef++}`;
    const entry: RefRecord = {
      publicRef,
      backendRef,
      generation,
      tabId: binding.tabId,
      windowId: binding.windowId,
      url,
      documentEpoch: sessions.get(session)?.documentEpoch ?? 0,
      role: row?.role ?? "unknown",
      name: row?.name ?? null,
    };
    cache.records.set(publicRef, entry);
    return publicRef;
  }

  function installSnapshot(
    session: string,
    binding: BrowserSession,
    tab: TabInfo,
    title: string,
    generation: string,
    backendText: string,
    truncated: boolean,
  ): SnapshotCache {
    const cache = getCache(session);
    const parsed = parseSnapshot(backendText);
    const rowRefs = new Map<string, string>();
    const refs = new Map<string, RefRecord>();
    for (const row of parsed.rows.slice(0, MAX_REFS)) {
      const publicRef = outputRef(
        session,
        row.backendRef,
        generation,
        binding,
        tab.url,
        row,
      );
      row.publicRef = publicRef;
      row.safeLine = row.safeLine.replace(row.backendRef, publicRef);
      rowRefs.set(row.backendRef, publicRef);
      refs.set(publicRef, cache.records.get(publicRef)!);
    }
    const text = parsed.text.replace(
      /@e[1-9]\d*/gu,
      (backendRef) => rowRefs.get(backendRef) ?? "",
    );
    const rows = parsed.rows.slice(0, MAX_REFS);
    const snapshot: SnapshotCache = {
      url: tab.url,
      tabId: tab.id,
      windowId: tab.windowId,
      title,
      generation,
      documentEpoch: sessions.get(session)?.documentEpoch ?? 0,
      truncated,
      rows,
      text,
      refs,
    };
    cache.snapshots.push(snapshot);
    while (cache.snapshots.length > MAX_GENERATIONS) {
      const removed = cache.snapshots.shift()!;
      for (const ref of removed.refs.keys()) cache.records.delete(ref);
    }
    while (cache.records.size > MAX_REFS * MAX_GENERATIONS) {
      const first = cache.records.keys().next().value as string | undefined;
      if (!first) break;
      cache.records.delete(first);
    }
    return snapshot;
  }

  function fitSnapshot(
    value: FirefoxSnapshot,
    maxBytes: number,
  ): FirefoxSnapshot {
    let result = { ...value };
    while (
      encoder.encode(JSON.stringify(result)).byteLength > maxBytes &&
      result.text.length > 0
    ) {
      const fit = fitText(
        result.text,
        Math.max(0, encoder.encode(result.text).byteLength - 16),
      );
      result = { ...result, text: fit.text, truncated: true };
    }
    if (encoder.encode(JSON.stringify(result)).byteLength > maxBytes)
      return { ...result, text: "", truncated: true };
    return result;
  }

  async function freshSnapshot(
    session: string,
    binding: BrowserSession,
    tab: TabInfo,
    maxBytes: number,
    depth: number | undefined,
    signal?: AbortSignal,
  ): Promise<
    { snapshot: SnapshotCache; text: string } | FirefoxBrowserFailure
  > {
    const targetArgs = target(binding);
    const titleResponse = await jsonCommand(
      ["get", "title", ...targetArgs, "--json"],
      signal,
    );
    if (!titleResponse.ok) return titleResponse.error;
    const titleTargetError = targetError(titleResponse.value, binding);
    if (titleTargetError) return titleTargetError;
    if (typeof titleResponse.value.value !== "string")
      return fail(
        "invalid_cli_response",
        "Firefox CLI returned invalid title data.",
      );
    const args = ["snapshot", "-c"];
    if (depth !== undefined) args.push("-d", String(depth));
    args.push("--max-output", String(maxBytes), ...targetArgs, "--json");
    const response = await jsonCommand(args, signal);
    if (!response.ok) return response.error;
    const snapshotTargetError = targetError(response.value, binding);
    if (snapshotTargetError) return snapshotTargetError;
    if (
      typeof response.value.text !== "string" ||
      typeof response.value.truncated !== "boolean" ||
      typeof response.value.generationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(response.value.generationId)
    )
      return fail(
        "invalid_cli_response",
        "Firefox CLI returned invalid snapshot data.",
      );
    const finalCheck = await checkedBinding(session, binding, signal);
    if (!finalCheck.ok) return finalCheck.error;
    if (!sameUrl(finalCheck.tab.url, tab.url))
      return fail(
        "page_changed",
        "The page changed during the snapshot. Read the session again.",
      );
    const title = fitText(titleResponse.value.value, 512);
    const installed = installSnapshot(
      session,
      binding,
      finalCheck.tab,
      title.text,
      response.value.generationId,
      response.value.text,
      response.value.truncated || title.truncated,
    );
    return { snapshot: installed, text: installed.text };
  }

  async function validateRef(
    session: string,
    binding: BrowserSession,
    tab: TabInfo,
    publicRef: string,
    signal?: AbortSignal,
  ): Promise<RefRecord | FirefoxBrowserFailure> {
    if (!/^e[1-9]\d*$/u.test(publicRef))
      return fail("invalid_ref", "The browser reference is invalid.");
    const recordValue = caches.get(session)?.records.get(publicRef);
    if (
      !recordValue ||
      recordValue.tabId !== binding.tabId ||
      recordValue.windowId !== binding.windowId ||
      !sameUrl(recordValue.url, tab.url) ||
      recordValue.documentEpoch !== (binding.documentEpoch ?? 0)
    )
      return fail(
        "stale_ref",
        "The browser reference is stale. Take a new snapshot.",
      );
    const response = await jsonCommand(
      [
        "ref",
        recordValue.backendRef,
        "--generation",
        recordValue.generation,
        ...target(binding),
        "--json",
      ],
      signal,
    );
    if (!response.ok) {
      if (response.error.code === "stale_ref")
        return fail(
          "stale_ref",
          "Firefox no longer resolves this reference. Take a new snapshot.",
        );
      return response.error;
    }
    const targetIssue = targetError(response.value, binding);
    if (targetIssue) return targetIssue;
    return recordValue;
  }

  async function readTextWithin(
    session: string,
    binding: BrowserSession,
    tab: TabInfo,
    input: Omit<FirefoxReadTextInput, "session">,
    signal?: AbortSignal,
  ): Promise<FirefoxBrowserResult<FirefoxReadText>> {
    const maxBytes = input.maxBytes ?? DEFAULT_READ_BYTES;
    if (!boundedInt(maxBytes, 256, MAX_READ_BYTES))
      return fail("invalid_input", "Text read limits are invalid.");
    let selector = "body";
    let reference: RefRecord | undefined;
    if (input.ref !== undefined) {
      const checkedRef = await validateRef(
        session,
        binding,
        tab,
        input.ref,
        signal,
      );
      if ("ok" in checkedRef) return checkedRef;
      reference = checkedRef;
      selector = checkedRef.backendRef;
    }
    const args = ["get", "text", selector];
    if (reference) args.push("--generation", reference.generation);
    args.push("--max-output", String(maxBytes), ...target(binding), "--json");
    const response = await jsonCommand(args, signal);
    if (!response.ok) return response.error;
    const error = targetError(response.value, binding);
    if (error) return error;
    const textValue =
      typeof response.value.value === "string"
        ? response.value.value
        : typeof response.value.text === "string"
          ? response.value.text
          : null;
    if (textValue === null)
      return fail(
        "invalid_cli_response",
        "Firefox CLI returned invalid visible text.",
      );
    const finalCheck = await checkedBinding(session, binding, signal);
    if (!finalCheck.ok) return finalCheck.error;
    if (!sameUrl(finalCheck.tab.url, tab.url))
      return fail(
        "page_changed",
        "The page changed during the text read. Read the session again.",
      );
    const fitted = fitText(textValue, maxBytes);
    return success(session, finalCheck.tab, {
      text: fitted.text,
      truncated: fitted.truncated || response.value.truncated === true,
      maxBytes,
    });
  }

  async function snapshotOperation(
    input: FirefoxSnapshotInput,
    signal?: AbortSignal,
  ): Promise<FirefoxBrowserResult<FirefoxSnapshot>> {
    if (
      !input ||
      !validSession(input.session) ||
      !["full", "scoped", "text"].includes(input.mode) ||
      (input.mode === "scoped" && !input.ref) ||
      (input.depth !== undefined && !boundedInt(input.depth, 0, 32)) ||
      (input.maxBytes !== undefined &&
        !boundedInt(input.maxBytes, 256, MAX_READ_BYTES)) ||
      (input.noText !== undefined && typeof input.noText !== "boolean")
    )
      return fail("invalid_input", "Snapshot options are invalid.");
    return withSession(input.session, signal, async () => {
      const owned = await ensureBinding(input.session, signal);
      if (!owned.ok) return owned.error;
      const maxBytes = input.maxBytes ?? DEFAULT_READ_BYTES;
      if (input.mode === "text") {
        if (input.noText) {
          return success(input.session, owned.tab, {
            mode: "text",
            title: "",
            text: "",
            generation: null,
            refs: 0,
            truncated: false,
            maxBytes,
          });
        }
        const text = await readTextWithin(
          input.session,
          owned.binding,
          owned.tab,
          { ...(input.ref ? { ref: input.ref } : {}), maxBytes },
          signal,
        );
        if (!text.ok) return text;
        const result: FirefoxSnapshot = {
          mode: "text",
          title: "",
          text: text.result.text,
          generation: null,
          refs: 0,
          truncated: text.result.truncated,
          maxBytes,
        };
        return success(input.session, owned.tab, fitSnapshot(result, maxBytes));
      }
      if (input.mode === "scoped") {
        const refRecord = await validateRef(
          input.session,
          owned.binding,
          owned.tab,
          input.ref!,
          signal,
        );
        if ("ok" in refRecord) return refRecord;
        const cached = caches
          .get(input.session)
          ?.snapshots.find(
            (entry) => entry.generation === refRecord.generation,
          );
        if (
          !cached ||
          cached.documentEpoch !== (owned.binding.documentEpoch ?? 0)
        )
          return fail(
            "stale_ref",
            "The browser reference is no longer in the snapshot cache. Take a new snapshot.",
          );
        const selected = scopedSnapshotText(cached.rows, input.ref!);
        if ("ok" in selected) return selected;
        const result: FirefoxSnapshot = {
          mode: "scoped",
          title: cached.title,
          text: input.noText ? "" : selected.text,
          generation: cached.generation,
          refs: selected.rows.length,
          truncated: cached.truncated,
          maxBytes,
        };
        return success(input.session, owned.tab, fitSnapshot(result, maxBytes));
      }
      const fresh = await freshSnapshot(
        input.session,
        owned.binding,
        owned.tab,
        maxBytes,
        input.depth,
        signal,
      );
      if ("ok" in fresh) return fresh;
      const allText = fresh.text;
      const fitted = fitText(input.noText ? "" : allText, maxBytes);
      const result: FirefoxSnapshot = {
        mode: "full",
        title: fresh.snapshot.title,
        text: fitted.text,
        generation: fresh.snapshot.generation,
        refs: fresh.snapshot.rows.length,
        truncated: fitted.truncated || fresh.snapshot.truncated,
        maxBytes,
      };
      return success(input.session, owned.tab, fitSnapshot(result, maxBytes));
    });
  }

  async function locateOperation(
    input: FirefoxLocateInput,
    signal?: AbortSignal,
  ): Promise<FirefoxBrowserResult<FirefoxLocatedElement>> {
    if (
      !input ||
      !validSession(input.session) ||
      ![input.role, input.name, input.text, input.label].some(
        (value) => typeof value === "string" && value.length > 0,
      ) ||
      [input.role, input.name, input.text, input.label].some(
        (value) =>
          value !== undefined &&
          (typeof value !== "string" || value.length > 500),
      ) ||
      (input.exact !== undefined && typeof input.exact !== "boolean")
    )
      return fail("invalid_input", "Locator options are invalid.");
    return withSession(input.session, signal, async () => {
      const owned = await ensureBinding(input.session, signal);
      if (!owned.ok) return owned.error;
      const fresh = await freshSnapshot(
        input.session,
        owned.binding,
        owned.tab,
        MAX_READ_BYTES,
        undefined,
        signal,
      );
      if ("ok" in fresh) return fresh;
      const match = fresh.snapshot.rows.filter((row) =>
        matchSnapshotRow(row, input),
      );
      if (!match.length)
        return fail("no_match", "No element matches this locator.");
      if (match.length > 1)
        return fail(
          "ambiguous_match",
          "More than one element matches this locator.",
        );
      const row = match[0]!;
      const ref = row.publicRef;
      if (!ref)
        return fail(
          "invalid_cli_response",
          "Firefox CLI returned an unusable reference.",
        );
      return success(input.session, owned.tab, {
        ref,
        role: row.role,
        name: row.name,
      });
    });
  }

  async function diffSnapshots(
    session: string,
    binding: BrowserSession,
    tab: TabInfo,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ rows: string[]; truncated: boolean } | FirefoxBrowserFailure> {
    const fresh = await freshSnapshot(
      session,
      binding,
      tab,
      maxBytes,
      undefined,
      signal,
    );
    if ("ok" in fresh) return fresh;
    const rows = fresh.snapshot.rows.map((row) =>
      row.safeLine.replace(/^(\s*)e[1-9]\d+\b/u, "$1e"),
    );
    return { rows, truncated: fresh.snapshot.truncated };
  }

  async function actOperation(
    input: FirefoxActInput,
    signal?: AbortSignal,
  ): Promise<FirefoxBrowserResult<FirefoxActionResult>> {
    if (
      !input ||
      !validSession(input.session) ||
      !["click", "fill", "key", "scroll", "select"].includes(input.action) ||
      (input.ref !== undefined &&
        (typeof input.ref !== "string" || !/^e[1-9]\d*$/u.test(input.ref))) ||
      (input.locate !== undefined && !record(input.locate)) ||
      (input.value !== undefined &&
        (typeof input.value !== "string" || input.value.length > 4_096)) ||
      (input.key !== undefined &&
        (typeof input.key !== "string" ||
          !/^[A-Za-z0-9+_-]{1,40}$/u.test(input.key))) ||
      (input.direction !== undefined &&
        !["up", "down", "left", "right"].includes(input.direction)) ||
      (input.amount !== undefined && !boundedInt(input.amount, 1, 10_000)) ||
      (input.noDiff !== undefined && typeof input.noDiff !== "boolean")
    )
      return fail("invalid_input", "Action options are invalid.");
    if (input.ref && input.locate)
      return fail("invalid_input", "Use a reference or a locator, not both.");
    if (input.action === "fill" && input.value === undefined)
      return fail("invalid_input", "Fill requires a value.");
    if (input.action === "select" && input.value === undefined)
      return fail("invalid_input", "Select requires a value.");
    if (input.action === "key" && (!input.key || input.ref || input.locate))
      return fail(
        "invalid_input",
        "Key actions require a key and cannot use an element reference.",
      );
    if (input.action === "scroll" && !input.direction)
      return fail("invalid_input", "Scroll requires a direction.");
    if (
      input.action !== "key" &&
      input.action !== "scroll" &&
      !input.ref &&
      !input.locate
    )
      return fail(
        "invalid_input",
        "This action requires a unique reference or locator.",
      );
    return withSession(input.session, signal, async () => {
      const owned = await ensureBinding(input.session, signal);
      if (!owned.ok) return owned.error;
      let refValue = input.ref ?? null;
      if (input.locate) {
        const fresh = await freshSnapshot(
          input.session,
          owned.binding,
          owned.tab,
          MAX_READ_BYTES,
          undefined,
          signal,
        );
        if ("ok" in fresh) return fresh;
        const match = fresh.snapshot.rows.filter((row) =>
          matchSnapshotRow(row, input.locate!),
        );
        if (match.length !== 1)
          return fail(
            match.length ? "ambiguous_match" : "no_match",
            match.length
              ? "More than one element matches this locator."
              : "No element matches this locator.",
          );
        refValue = match[0]!.publicRef ?? null;
      }
      let reference: RefRecord | undefined;
      if (refValue) {
        const checkedRef = await validateRef(
          input.session,
          owned.binding,
          owned.tab,
          refValue,
          signal,
        );
        if ("ok" in checkedRef) return checkedRef;
        reference = checkedRef;
      }
      const before = input.noDiff
        ? null
        : await diffSnapshots(
            input.session,
            owned.binding,
            owned.tab,
            4_000,
            signal,
          );
      if (before && "ok" in before) return before;
      if (reference) {
        const revalidated = await validateRef(
          input.session,
          owned.binding,
          owned.tab,
          refValue!,
          signal,
        );
        if ("ok" in revalidated) return revalidated;
      }
      const args: string[] = [];
      if (input.action === "click")
        args.push(
          "click",
          reference!.backendRef,
          "--generation",
          reference!.generation,
        );
      if (input.action === "fill")
        args.push(
          "fill",
          reference!.backendRef,
          input.value!,
          "--generation",
          reference!.generation,
        );
      if (input.action === "select")
        args.push(
          "select",
          reference!.backendRef,
          input.value!,
          "--generation",
          reference!.generation,
        );
      if (input.action === "key") args.push("press", input.key!);
      if (input.action === "scroll") {
        args.push("scroll", input.direction!);
        if (input.amount !== undefined) args.push(String(input.amount));
        if (reference)
          args.push(reference.backendRef, "--generation", reference.generation);
      }
      args.push(...target(owned.binding), "--json");
      const command = await cli(args, signal);
      if (!command.ok || command.value.exitCode !== 0) {
        owned.binding.uncertain = true;
        return fail(
          "mutation_uncertain",
          "The browser action may have occurred. Do not replay it automatically.",
        );
      }
      const afterCheck = await checkedBinding(
        input.session,
        owned.binding,
        signal,
      );
      if (!afterCheck.ok) {
        owned.binding.uncertain = true;
        return afterCheck.error;
      }
      if (afterCheck.tab.cookieStoreId !== owned.binding.cookieStoreId) {
        owned.binding.uncertain = true;
        return fail(
          "container_conflict",
          "The action changed the owned tab's container.",
        );
      }
      if (!sameUrl(afterCheck.tab.url, owned.tab.url)) clearRefs(input.session);
      let diff: FirefoxActionDiff | null = null;
      if (before) {
        const after = await diffSnapshots(
          input.session,
          owned.binding,
          afterCheck.tab,
          4_000,
          signal,
        );
        if ("ok" in after) return after;
        const beforeRows = (before as { rows: string[]; truncated: boolean })
          .rows;
        const beforeSet = new Set(beforeRows);
        const afterSet = new Set(after.rows);
        diff = {
          added: after.rows.filter((line) => !beforeSet.has(line)).slice(0, 20),
          removed: beforeRows
            .filter((line) => !afterSet.has(line))
            .slice(0, 20),
          truncated: after.truncated || beforeRows.length > 20,
        };
      }
      return success(input.session, afterCheck.tab, {
        action: input.action,
        ref: refValue,
        diff,
      });
    });
  }

  async function waitOperation(
    input: FirefoxWaitInput,
    signal?: AbortSignal,
  ): Promise<FirefoxBrowserResult<FirefoxWaitResult>> {
    if (
      !input ||
      !validSession(input.session) ||
      [input.ref, input.text, input.url].filter((value) => value !== undefined)
        .length !== 1 ||
      (input.ref !== undefined &&
        (typeof input.ref !== "string" || !/^e[1-9]\d*$/u.test(input.ref))) ||
      (input.text !== undefined &&
        (typeof input.text !== "string" ||
          !input.text.length ||
          input.text.length > 2_000)) ||
      (input.url !== undefined &&
        (typeof input.url !== "string" ||
          !input.url.length ||
          input.url.length > 2_000)) ||
      (input.timeoutMs !== undefined &&
        !boundedInt(input.timeoutMs, 1, MAX_WAIT_MS))
    )
      return fail("invalid_input", "Wait options are invalid.");
    return withSession(input.session, signal, async () => {
      const owned = await ensureBinding(input.session, signal);
      if (!owned.ok) return owned.error;
      const started = Date.now();
      const timeoutMs = input.timeoutMs ?? 5_000;
      let args: string[];
      if (input.ref) {
        const reference = await validateRef(
          input.session,
          owned.binding,
          owned.tab,
          input.ref,
          signal,
        );
        if ("ok" in reference) return reference;
        args = [
          "wait",
          reference.backendRef,
          "--generation",
          reference.generation,
          "--state",
          "visible",
        ];
      } else if (input.text !== undefined)
        args = ["wait", "--text", input.text];
      else args = ["wait", "--url", input.url!];
      args.push(
        "--timeout",
        String(timeoutMs),
        ...target(owned.binding),
        "--json",
      );
      const response = await jsonCommand(args, signal);
      if (!response.ok) return response.error;
      const error = targetError(response.value, owned.binding);
      if (error) return error;
      if (response.value.matched !== true)
        return fail(
          "wait_timeout",
          "Firefox did not satisfy the requested wait.",
        );
      const final = await checkedBinding(input.session, owned.binding, signal);
      if (!final.ok) return final.error;
      const elapsedMs =
        typeof response.value.elapsedMs === "number" &&
        Number.isFinite(response.value.elapsedMs)
          ? Math.min(timeoutMs, Math.max(0, response.value.elapsedMs))
          : Math.min(timeoutMs, Math.max(0, Date.now() - started));
      return success(input.session, final.tab, {
        matched: true,
        elapsedMs,
      } as FirefoxWaitResult);
    });
  }

  async function networkOperation(
    input: FirefoxNetworkInput,
    signal?: AbortSignal,
  ): Promise<FirefoxBrowserResult<FirefoxNetworkResult>> {
    if (
      !input ||
      !validSession(input.session) ||
      (input.origin !== undefined &&
        (typeof input.origin !== "string" || input.origin.length > 2_000)) ||
      (input.method !== undefined &&
        (typeof input.method !== "string" || input.method.length > 20)) ||
      (input.type !== undefined &&
        (typeof input.type !== "string" || input.type.length > 40)) ||
      (input.status !== undefined && !boundedInt(input.status, 100, 599)) ||
      (input.urlsOnly !== undefined && typeof input.urlsOnly !== "boolean") ||
      (input.maxEntries !== undefined &&
        !boundedInt(input.maxEntries, 1, MAX_NETWORK_ENTRIES)) ||
      (input.cursor !== undefined && typeof input.cursor !== "string")
    )
      return fail("invalid_input", "Network options are invalid.");
    if (input.cursor !== undefined)
      return fail(
        "unsupported_capability",
        "The backend does not provide stable network cursors.",
      );
    let originGlob: string | undefined;
    if (input.origin) {
      try {
        const parsed = new URL(input.origin);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          parsed.pathname !== "/"
        )
          return fail(
            "invalid_input",
            "Network origin must be a credential-free HTTP origin.",
          );
        originGlob = parsed.origin + "/*";
      } catch {
        return fail(
          "invalid_input",
          "Network origin must be a credential-free HTTP origin.",
        );
      }
    }
    return withSession(input.session, signal, async () => {
      const owned = await ensureBinding(input.session, signal);
      if (!owned.ok) return owned.error;
      const args = ["network", "list"];
      if (originGlob) args.push("--url", originGlob);
      args.push(...target(owned.binding), "--json");
      const response = await jsonCommand(args, signal);
      if (!response.ok) return response.error;
      if (!Array.isArray(response.value.requests))
        return fail(
          "invalid_cli_response",
          "Firefox CLI returned invalid network data.",
        );
      const limit = input.maxEntries ?? DEFAULT_NETWORK_ENTRIES;
      const entries: FirefoxNetworkResult["entries"] = [];
      let matched = 0;
      for (const raw of response.value.requests) {
        if (!record(raw) || typeof raw.url !== "string") continue;
        const method =
          typeof raw.method === "string" ? raw.method.slice(0, 20) : undefined;
        const type =
          typeof raw.type === "string" ? raw.type.slice(0, 40) : undefined;
        const status =
          typeof raw.statusCode === "number" &&
          boundedInt(raw.statusCode, 100, 599)
            ? raw.statusCode
            : undefined;
        if (
          input.method &&
          method?.toUpperCase() !== input.method.toUpperCase()
        )
          continue;
        if (input.type && type?.toLowerCase() !== input.type.toLowerCase())
          continue;
        if (input.status !== undefined && status !== input.status) continue;
        matched += 1;
        if (entries.length >= limit) continue;
        entries.push({
          url: scrubUrl(raw.url),
          ...(input.urlsOnly ? {} : method ? { method } : {}),
          ...(input.urlsOnly ? {} : type ? { type } : {}),
          ...(input.urlsOnly ? {} : status !== undefined ? { status } : {}),
        });
      }
      let truncated =
        matched > entries.length || response.value.truncated === true;
      while (
        entries.length > 0 &&
        encoder.encode(
          JSON.stringify({
            entries,
            truncated,
            retentionMs: 30_000,
            cursor: null,
          }),
        ).byteLength > MAX_NETWORK_RESULT_BYTES
      ) {
        entries.pop();
        truncated = true;
      }
      const final = await checkedBinding(input.session, owned.binding, signal);
      if (!final.ok) return final.error;
      return success(input.session, final.tab, {
        entries,
        truncated,
        retentionMs: 30_000,
        cursor: null,
      });
    });
  }

  async function screenshotOperation(
    input: FirefoxScreenshotInput,
    signal?: AbortSignal,
  ): Promise<FirefoxBrowserResult<FirefoxScreenshotResult>> {
    if (
      !input ||
      !validSession(input.session) ||
      (input.outputPath !== undefined &&
        (typeof input.outputPath !== "string" ||
          !input.outputPath.trim() ||
          input.outputPath.length > 4_096 ||
          /[\u0000-\u001f]/u.test(input.outputPath))) ||
      (input.fullResolution !== undefined &&
        typeof input.fullResolution !== "boolean") ||
      (input.focus !== undefined && typeof input.focus !== "boolean")
    )
      return fail("invalid_input", "Screenshot options are invalid.");
    return withSession(input.session, signal, async () => {
      const owned = await ensureBinding(input.session, signal);
      if (!owned.ok) return owned.error;
      const outputPath = input.outputPath
        ? isAbsolute(input.outputPath)
          ? resolve(input.outputPath)
          : resolve(process.cwd(), input.outputPath)
        : join(tmpdir(), `pi-firefox-shot-${randomUUID()}.png`);
      let tempDirectory: string | undefined;
      try {
        await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
        tempDirectory = await mkdtemp(join(tmpdir(), "pi-firefox-shot-"));
        await chmod(tempDirectory, 0o700);
        const path = join(tempDirectory, "capture.png");
        const args = ["screenshot", path, ...target(owned.binding)];
        if (input.focus) args.push("--focus");
        args.push("--json");
        const response = await jsonCommand(args, signal);
        if (!response.ok) return response.error;
        const error = targetError(response.value, owned.binding);
        const activation = response.value.activation;
        const resultTarget = response.value.target;
        if (
          error ||
          response.value.path !== path ||
          response.value.format !== "png" ||
          !record(activation) ||
          typeof activation.tabActivated !== "boolean" ||
          typeof activation.windowFocused !== "boolean" ||
          !record(resultTarget) ||
          resultTarget.cookieStoreId !== owned.binding.cookieStoreId ||
          resultTarget.private === true ||
          (typeof resultTarget.url === "string" &&
            !sameUrl(resultTarget.url, owned.tab.url))
        )
          return (
            error ??
            fail(
              "screenshot_target_changed",
              "Firefox returned screenshot metadata for a different capture target.",
            )
          );
        const final = await checkedBinding(
          input.session,
          owned.binding,
          signal,
        );
        if (!final.ok) return final.error;
        const listed = await context.listTabs(owned.binding.windowId, signal);
        if (!listed.ok) return listed.error;
        const activeTabs = listed.value.filter((tab) => tab.active === true);
        const selected = listed.value.find(
          (tab) => tab.id === owned.binding.tabId,
        );
        if (
          !selected ||
          selected.private ||
          selected.active !== true ||
          selected.windowId !== owned.binding.windowId ||
          selected.cookieStoreId !== owned.binding.cookieStoreId ||
          !sameUrl(selected.url, owned.tab.url) ||
          activeTabs.length !== 1 ||
          !sameUrl(final.tab.url, owned.tab.url)
        )
          return fail(
            "screenshot_target_changed",
            "The owned tab was not the selected capture target. The screenshot was discarded.",
          );
        try {
          const file = await stat(path);
          if (!file.isFile() || file.size < 1) throw new Error("invalid file");
          await chmod(path, 0o600);
        } catch {
          return fail(
            "screenshot_failed",
            "Firefox did not create a readable screenshot file.",
          );
        }
        let resized = false;
        let resizeWarning: string | undefined;
        if (!input.fullResolution) {
          const processResult = await new Promise<{ ok: boolean }>(
            (resolveResult) => {
              execFile(
                "sips",
                ["-Z", "1200", path],
                { timeout: 15_000, windowsHide: true },
                (error) => resolveResult({ ok: !error }),
              );
            },
          );
          resized = processResult.ok;
          if (!resized)
            resizeWarning =
              "Local resizing with sips is unavailable; the original screenshot was kept.";
        }
        await chmod(path, 0o600);
        try {
          await copyFile(path, outputPath, fsConstants.COPYFILE_EXCL);
          await chmod(outputPath, 0o600);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          )
            return fail("file_exists", "The screenshot path already exists.");
          return fail(
            "screenshot_failed",
            "The screenshot file could not be published.",
          );
        }
        return success(input.session, final.tab, {
          path: outputPath,
          format: "png",
          resized,
          ...(resizeWarning ? { resizeWarning } : {}),
          selected: true,
          fullPage: false,
        });
      } catch {
        return fail(
          "screenshot_failed",
          "The screenshot could not be captured.",
        );
      } finally {
        if (tempDirectory)
          await rm(tempDirectory, { recursive: true, force: true }).catch(
            () => undefined,
          );
      }
    });
  }

  async function sessionList(
    input: { session?: string } = {},
    callOptions: { signal?: AbortSignal } = {},
  ): Promise<FirefoxJsonResult<FirefoxSessionSummary[]>> {
    if (callOptions.signal?.aborted)
      return fail("aborted", "The browser operation was cancelled.");
    if (!input || (input.session !== undefined && !validSession(input.session)))
      return fail("invalid_input", "Session list options are invalid.");
    const values = [...sessions.entries()].filter(
      ([name]) => !input.session || name === input.session,
    );
    const result = values.map(([session, binding]) => ({
      session,
      tab: {
        id: binding.tabId,
        windowId: binding.windowId,
        url: safeUrl(binding.expectedUrl),
      },
      containerId: binding.cookieStoreId,
      state: binding.pending
        ? ("confirmation_pending" as const)
        : binding.uncertain
          ? ("uncertain" as const)
          : binding.closed
            ? ("closed" as const)
            : ("open" as const),
      lastUsedAt:
        typeof binding.lastUsedAtMs === "number"
          ? new Date(binding.lastUsedAtMs).toISOString()
          : null,
    }));
    return { ok: true, result };
  }

  async function sessionCleanup(
    input: FirefoxSessionCleanupInput,
    callOptions: { signal?: AbortSignal } = {},
  ): Promise<FirefoxJsonResult<FirefoxSessionCleanupResult>> {
    if (
      !input ||
      !boundedInt(input.idleAfterMs, 1, 365 * 24 * 60 * 60 * 1_000) ||
      (input.dryRun !== undefined && typeof input.dryRun !== "boolean")
    )
      return fail("invalid_input", "Session cleanup options are invalid.");
    const dryRun = input.dryRun !== false;
    const eligible: FirefoxSessionCleanupResult["eligible"] = [];
    const failures: FirefoxSessionCleanupResult["failures"] = [];
    const closed: string[] = [];
    const cutoff = Date.now() - input.idleAfterMs;
    for (const [session, binding] of [...sessions.entries()]) {
      if (
        binding.closed ||
        binding.uncertain ||
        binding.pending ||
        (binding.lastUsedAtMs ?? Date.now()) > cutoff
      )
        continue;
      const checked = await withSession(
        session,
        callOptions.signal,
        async () => {
          const current = sessions.get(session);
          if (
            !current ||
            current.closed ||
            current.uncertain ||
            current.pending ||
            (current.lastUsedAtMs ?? Date.now()) > cutoff
          )
            return fail(
              "session_changed",
              "The session is no longer eligible.",
            );
          const verified = await checkedBinding(
            session,
            current,
            callOptions.signal,
          );
          if (!verified.ok) return verified.error;
          return success(session, verified.tab, {
            tabId: current.tabId,
            url: safeUrl(verified.tab.url),
          });
        },
        { touch: false },
      );
      if (!checked.ok) {
        failures.push({ session, code: checked.code });
        continue;
      }
      eligible.push({
        session,
        tabId: checked.result.tabId,
        url: checked.result.url,
        containerId: checked.container.cookieStoreId,
      });
      if (dryRun) continue;
      const closedResult = await withSession(
        session,
        callOptions.signal,
        async () => {
          const current = sessions.get(session);
          if (
            !current ||
            current.closed ||
            current.uncertain ||
            current.pending ||
            (current.lastUsedAtMs ?? Date.now()) > cutoff
          )
            return fail(
              "session_changed",
              "The session is no longer eligible.",
            );
          const verified = await checkedBinding(
            session,
            current,
            callOptions.signal,
          );
          if (!verified.ok) return verified.error;
          const command = await cli(
            [
              "tab",
              "close",
              `id:${current.tabId}`,
              "--window",
              `id:${current.windowId}`,
              "--json",
            ],
            callOptions.signal,
          );
          if (!command.ok || command.value.exitCode !== 0) {
            current.uncertain = true;
            return fail(
              "mutation_uncertain",
              "Tab cleanup may have occurred. Do not replay it automatically.",
            );
          }
          let payload: unknown;
          try {
            payload = JSON.parse(command.value.stdout);
          } catch {
            payload = null;
          }
          if (!record(payload) || payload.closedTabId !== current.tabId) {
            current.uncertain = true;
            return fail(
              "mutation_uncertain",
              "Tab cleanup has an uncertain outcome. Do not replay it automatically.",
            );
          }
          current.closed = true;
          current.documentEpoch = (current.documentEpoch ?? 0) + 1;
          return success(session, verified.tab, { closed: true });
        },
        { touch: false },
      );
      if (closedResult.ok) closed.push(session);
      else failures.push({ session, code: closedResult.code });
    }
    return { ok: true, result: { dryRun, eligible, closed, failures } };
  }

  return {
    snapshot(
      input: FirefoxSnapshotInput,
      callOptions: { signal?: AbortSignal } = {},
    ) {
      return snapshotOperation(input, callOptions.signal);
    },
    locate(
      input: FirefoxLocateInput,
      callOptions: { signal?: AbortSignal } = {},
    ) {
      return locateOperation(input, callOptions.signal);
    },
    act(input: FirefoxActInput, callOptions: { signal?: AbortSignal } = {}) {
      return actOperation(input, callOptions.signal);
    },
    wait(input: FirefoxWaitInput, callOptions: { signal?: AbortSignal } = {}) {
      return waitOperation(input, callOptions.signal);
    },
    network(
      input: FirefoxNetworkInput,
      callOptions: { signal?: AbortSignal } = {},
    ) {
      return networkOperation(input, callOptions.signal);
    },
    screenshot(
      input: FirefoxScreenshotInput,
      callOptions: { signal?: AbortSignal } = {},
    ) {
      return screenshotOperation(input, callOptions.signal);
    },
    readText(
      input: FirefoxReadTextInput,
      callOptions: { signal?: AbortSignal } = {},
    ): Promise<FirefoxBrowserResult<FirefoxReadText>> {
      if (
        !input ||
        !validSession(input.session) ||
        (input.ref !== undefined &&
          (typeof input.ref !== "string" || !/^e[1-9]\d*$/u.test(input.ref)))
      )
        return Promise.resolve(
          fail("invalid_input", "Text read options are invalid."),
        );
      return withSession(input.session, callOptions.signal, async () => {
        const owned = await ensureBinding(input.session, callOptions.signal);
        if (!owned.ok) return owned.error;
        return readTextWithin(
          input.session,
          owned.binding,
          owned.tab,
          input,
          callOptions.signal,
        );
      });
    },
    sessionList,
    sessionCleanup,
  };
}

function scrubUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 2_000);
  } catch {
    return "invalid-url";
  }
}
