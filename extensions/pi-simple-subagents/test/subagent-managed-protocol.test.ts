import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  decodeManagedBootEnv,
  encodeManagedBootEnv,
  inboxFileName,
  inboxFileSeq,
  type ManagedBoot,
  MANAGED_BOOT_ID_ENV,
  MANAGED_CONTROL_FLOOR_ENV,
  MANAGED_DIR_ENV,
  MANAGED_FRESH_ATTEMPT_ENV,
  MANAGED_HOLD_ON_MODEL_ERROR_ENV,
  MANAGED_MAX_INACTIVITY_ENV,
  MANAGED_MAX_RUNTIME_ENV,
  MANAGED_PARENT_PID_ENV,
  MANAGED_RESUME_FLOOR_ENV,
  MANAGED_SESSION_ID_ENV,
  parseInboxMessage,
} from "../src/_managed-protocol.ts";
import {
  enqueueInbox,
  listManagedHandles,
  type ManagedConfig,
  managedPaths,
  readChildStatus,
  readChildStatusResult,
  readInbox,
  readManagedConfig,
  readManagedConfigResult,
  readStderrTail,
  writeFileAtomic,
  writeInboxMessage,
  writeJsonAtomic,
} from "../src/_managed-store.ts";
import { truncateUtf8Tail } from "../src/_text.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-protocol-"));
  roots.push(dir);
  return dir;
}

const boot: ManagedBoot = {
  dir: "/w/mw-abc123",
  bootId: "boot-7",
  parentPid: 321,
  expectedSessionId: "sess-9",
  resumeFloorSeq: 4,
  controlFloorSeq: 4,
  freshAttempt: false,
  holdOnInitialModelError: true,
  limits: { maxRuntimeMs: 60_000, maxInactivityMs: 5_000 },
};

describe("managed boot environment codec", () => {
  test("encodes exactly the variables the parent runtime writes", () => {
    // The runtime launches every boot with this encoding; its tests decode the launched env.
    const floor = "4";
    expect(encodeManagedBootEnv(boot)).toEqual({
      [MANAGED_DIR_ENV]: "/w/mw-abc123",
      [MANAGED_BOOT_ID_ENV]: "boot-7",
      [MANAGED_PARENT_PID_ENV]: "321",
      [MANAGED_RESUME_FLOOR_ENV]: floor,
      [MANAGED_CONTROL_FLOOR_ENV]: floor,
      [MANAGED_HOLD_ON_MODEL_ERROR_ENV]: "1",
      [MANAGED_FRESH_ATTEMPT_ENV]: "0",
      [MANAGED_MAX_RUNTIME_ENV]: "60000",
      [MANAGED_MAX_INACTIVITY_ENV]: "5000",
      [MANAGED_SESSION_ID_ENV]: "sess-9",
    });
    expect(
      Object.keys(encodeManagedBootEnv({ ...boot, resumeFloorSeq: 0 })),
    ).toHaveLength(10);
    expect(
      encodeManagedBootEnv({ ...boot, resumeFloorSeq: 0 })[
        MANAGED_RESUME_FLOOR_ENV
      ],
    ).toBe("0");
  });

  test("decode reverses encode", () => {
    expect(decodeManagedBootEnv(encodeManagedBootEnv(boot))).toEqual({
      kind: "ok",
      boot,
    });
    const { parentPid: _unused, ...withoutParent } = boot;
    const fresh: ManagedBoot = {
      ...withoutParent,
      freshAttempt: true,
      holdOnInitialModelError: false,
      resumeFloorSeq: 0,
    };
    const encoded = encodeManagedBootEnv(fresh);
    expect(encoded[MANAGED_PARENT_PID_ENV]).toBe("0");
    expect(decodeManagedBootEnv(encoded)).toEqual({ kind: "ok", boot: fresh });
  });

  test("an unrelated environment is absent; a partial or malformed one is invalid", () => {
    expect(decodeManagedBootEnv({ PATH: "/bin" })).toEqual({ kind: "absent" });
    const partial = decodeManagedBootEnv({ [MANAGED_DIR_ENV]: "/d" });
    expect(partial.kind).toBe("invalid");
    expect(partial.kind === "invalid" && partial.message).toMatch(
      /incomplete: missing PI_MANAGED_SUBAGENT_BOOT_ID/,
    );
    const env = encodeManagedBootEnv(boot);
    expect(
      decodeManagedBootEnv({ ...env, [MANAGED_CONTROL_FLOOR_ENV]: "-1" }),
    ).toEqual({
      kind: "invalid",
      message:
        "Managed worker environment is invalid: PI_MANAGED_SUBAGENT_CONTROL_FLOOR must be a non-negative integer.",
    });
    expect(
      decodeManagedBootEnv({
        ...env,
        [MANAGED_HOLD_ON_MODEL_ERROR_ENV]: "true",
        [MANAGED_MAX_RUNTIME_ENV]: "x",
      }),
    ).toEqual({
      kind: "invalid",
      message:
        "Managed worker environment is invalid: PI_MANAGED_SUBAGENT_HOLD_ON_MODEL_ERROR must be 0 or 1.",
    });
  });
});

describe("managed inbox protocol", () => {
  test("file names sort by sequence and round-trip the sequence", () => {
    const name = inboxFileName({
      kind: "shutdown",
      seq: 12,
      id: "m-1",
      createdAt: 0,
    });
    expect(name).toBe("0000000012-m-1.json");
    expect(inboxFileSeq(name)).toBe(12);
    expect(inboxFileSeq("notes.txt")).toBeUndefined();
  });

  test("rejects malformed inbox records", () => {
    expect(
      parseInboxMessage({ kind: "shutdown", seq: 1, id: "m", createdAt: 1 }),
    ).toEqual({ kind: "shutdown", seq: 1, id: "m", createdAt: 1 });
    expect(
      parseInboxMessage({
        kind: "assignment",
        seq: 1,
        id: "m",
        assignmentId: "a",
        delivery: "later",
        text: "t",
        createdAt: 1,
      }),
    ).toBeUndefined();
  });
});

function config(handle = "mw-abc123"): ManagedConfig {
  return {
    v: 1,
    handle,
    parentSessionId: "parent",
    createdAt: 1,
    launch: {
      agent: { name: "bee", source: "user" },
      modelCandidates: ["m"],
      cwd: "/",
      trace: {
        rootSessionId: "r",
        parentSessionId: "parent",
        parentToolCallId: "t",
        depth: 1,
      },
      isolation: {},
      taskPreview: "",
    },
    lifecycle: "running",
    candidateIndex: 0,
    sessionId: "s",
    attempts: [],
    nextSeq: 2,
    lastAssignmentId: "a1",
    updatedAt: 1,
  };
}

describe("managed store reads", () => {
  test("result reads distinguish missing, invalid, and ok", () => {
    const dir = tempDir();
    const paths = managedPaths(dir);
    expect(readManagedConfigResult(paths.config)).toEqual({ kind: "missing" });
    fs.writeFileSync(paths.config, "{ torn");
    expect(readManagedConfigResult(paths.config).kind).toBe("invalid");
    expect(readManagedConfig(paths.config)).toBeUndefined();
    writeJsonAtomic(paths.config, { v: 1 });
    expect(readManagedConfigResult(paths.config)).toEqual({
      kind: "invalid",
      reason: "not a valid managed config",
    });
    writeJsonAtomic(paths.config, config());
    expect(readManagedConfigResult(paths.config)).toMatchObject({
      kind: "ok",
      value: { handle: "mw-abc123" },
    });
    expect(readChildStatusResult(paths.status)).toEqual({ kind: "missing" });
    expect(readChildStatus(paths.status)).toBeUndefined();
  });

  test("atomic writes leave no temp files and replace content", () => {
    const dir = tempDir();
    const file = path.join(dir, "nested", "file.txt");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, "two");
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["file.txt"]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("readInbox filters by file-name sequence before parsing", () => {
    const dir = tempDir();
    const inbox = managedPaths(dir).inbox;
    for (const seq of [1, 2, 3])
      writeInboxMessage(inbox, {
        kind: "shutdown",
        seq,
        id: `m${seq}`,
        createdAt: seq,
      });
    // A corrupt file at or below the floor is never read.
    fs.writeFileSync(path.join(inbox, "0000000001-m1.json"), "{ torn");
    fs.writeFileSync(path.join(inbox, "README"), "foreign");
    expect(readInbox(inbox).map((message) => message.seq)).toEqual([2, 3]);
    expect(
      readInbox(inbox, { afterSeq: 2 }).map((message) => message.seq),
    ).toEqual([3]);
    expect(readInbox(inbox, { afterSeq: 3 })).toEqual([]);
    expect(readInbox(path.join(dir, "missing"))).toEqual([]);
  });

  test("lists only managed handle directories", () => {
    const dir = tempDir();
    for (const name of ["mw-bbbbbb", "mw-aaaaaa", "notes", "mw-x"])
      fs.mkdirSync(path.join(dir, name));
    expect(listManagedHandles(dir)).toEqual(["mw-aaaaaa", "mw-bbbbbb"]);
    expect(listManagedHandles(path.join(dir, "missing"))).toEqual([]);
  });

  test("reads only the stderr tail without splitting a code point", () => {
    const dir = tempDir();
    const file = path.join(dir, "stderr.log");
    expect(readStderrTail(file, 16)).toBe("");
    const content = `${"a".repeat(30)}é€😀 tail\n`;
    fs.writeFileSync(file, content);
    for (const maxBytes of [0, 5, 7, 8, 9, 10, 11, 12, 13, 14, 100])
      expect(readStderrTail(file, maxBytes)).toBe(
        truncateUtf8Tail(content, maxBytes).value,
      );
  });
});

describe("managed store enqueue", () => {
  test("allocates the next sequence, persists config first, then writes the inbox file", () => {
    const dir = tempDir();
    const paths = managedPaths(dir);
    const current = config();
    const result = enqueueInbox(
      dir,
      current,
      {
        kind: "assignment",
        id: "m-2",
        assignmentId: "a2",
        delivery: "followUp",
        text: "next",
        createdAt: 50,
      },
      99,
    );
    expect(result).toEqual({
      kind: "enqueued",
      message: {
        kind: "assignment",
        seq: 2,
        id: "m-2",
        assignmentId: "a2",
        delivery: "followUp",
        text: "next",
        createdAt: 50,
      },
    });
    expect(current).toMatchObject({
      nextSeq: 3,
      lastAssignmentId: "a2",
      updatedAt: 99,
    });
    expect(readManagedConfig(paths.config)).toMatchObject({
      nextSeq: 3,
      lastAssignmentId: "a2",
      updatedAt: 99,
    });

    const shutdown = enqueueInbox(
      dir,
      current,
      { kind: "shutdown", id: "m-3", createdAt: 60 },
      100,
    );
    expect(shutdown).toMatchObject({ kind: "enqueued", message: { seq: 3 } });
    expect(current).toMatchObject({ nextSeq: 4, lastAssignmentId: "a2" });
    expect(readInbox(paths.inbox).map((message) => message.seq)).toEqual([
      2, 3,
    ]);
  });

  test("an inbox write failure is a value and the sequence stays spent", () => {
    const dir = tempDir();
    const paths = managedPaths(dir);
    // A file where the inbox directory should be makes the inbox write fail.
    fs.writeFileSync(paths.inbox, "not a directory");
    const current = config();
    const result = enqueueInbox(
      dir,
      current,
      { kind: "shutdown", id: "m-2", createdAt: 1 },
      5,
    );
    expect(result.kind).toBe("inboxWriteFailed");
    expect(readManagedConfig(paths.config)?.nextSeq).toBe(3);
  });

  test("a config write failure is a value and nothing reaches the inbox", () => {
    const dir = tempDir();
    const paths = managedPaths(dir);
    fs.mkdirSync(paths.config, { recursive: true });
    const result = enqueueInbox(
      dir,
      config(),
      { kind: "shutdown", id: "m-2", createdAt: 1 },
      5,
    );
    expect(result.kind).toBe("configWriteFailed");
    expect(readInbox(paths.inbox)).toEqual([]);
  });
});
