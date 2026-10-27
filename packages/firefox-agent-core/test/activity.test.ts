import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { createFirefoxActivityGate } from "../src/activity.js";
import { createFirefoxStateStore } from "../src/state-store.js";

test("independent tab operations overlap while a browser-wide writer waits for both", async () => {
  const root = await mkdtemp(join(tmpdir(), "firefox-activity-"));
  const events: string[] = [];
  try {
    const first = createFirefoxActivityGate({
      path: join(root, "activity.json"),
    });
    const second = createFirefoxActivityGate({
      path: join(root, "activity.json"),
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const read = (name: string) => async () => {
      events.push(name + "-start");
      started++;
      if (started === 2) release();
      await barrier;
      await delay(30);
      events.push(name + "-end");
    };
    const readers = [
      first.run("read", read("a")),
      second.run("read", read("b")),
    ];
    await barrier;
    const writer = first.run("write", async () => {
      events.push("writer");
    });
    await Promise.all([...readers, writer]);
    expect(events.indexOf("a-start")).toBeLessThan(events.indexOf("b-end"));
    expect(events.indexOf("b-start")).toBeLessThan(events.indexOf("a-end"));
    expect(events.indexOf("writer")).toBeGreaterThan(events.indexOf("a-end"));
    expect(events.indexOf("writer")).toBeGreaterThan(events.indexOf("b-end"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("session lanes serialize separate clients without poisoning the lane after failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "firefox-lane-"));
  try {
    const path = join(root, "activity.json");
    const first = createFirefoxActivityGate({ path });
    const second = createFirefoxActivityGate({ path });
    const events: string[] = [];
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const a = first.withSessionLane("same", async () => {
      events.push("start");
      entered();
      await delay(40);
      events.push("end");
    });
    await firstEntered;
    const b = second.withSessionLane("same", async () => {
      events.push("next");
    });
    await Promise.all([a, b]);
    expect(events).toEqual(["start", "end", "next"]);
    await expect(
      first.withSessionLane("same", async () => {
        throw new Error("synthetic");
      }),
    ).rejects.toThrow("synthetic");
    expect(await second.withSessionLane("same", async () => "usable")).toBe(
      "usable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("reclaims reader and writer records after PID reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "firefox-pid-reuse-"));
  try {
    const path = join(root, "activity.json");
    const store = createFirefoxStateStore({ path });
    const readerToken = randomUUID();
    const writerToken = randomUUID();
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    await store.withEntry("activity", async () => ({
      entry: {
        readers: {
          [readerToken]: { pid: process.pid, uid, start: "previous-process" },
        },
        writer: {
          token: writerToken,
          pid: process.pid,
          uid,
          start: "previous-process",
        },
      },
      result: undefined,
    }));
    const gate = createFirefoxActivityGate({
      path,
      getProcessIdentity: async () => ({ uid, start: "current-process" }),
    });
    await expect(gate.run("read", async () => "entered")).resolves.toBe(
      "entered",
    );
    const state = await store.list();
    expect(state.activity).toMatchObject({ readers: {}, writer: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("unknown owner identity blocks without deleting the reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "firefox-unknown-owner-"));
  try {
    const path = join(root, "activity.json");
    const store = createFirefoxStateStore({ path });
    const token = randomUUID();
    await store.withEntry("activity", async () => ({
      entry: { readers: { [token]: { pid: process.pid } }, writer: null },
      result: undefined,
    }));
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gate = createFirefoxActivityGate({
      path,
      timeoutMs: 120,
      getProcessIdentity: async () => ({ uid, start: "current-process" }),
    });
    await expect(
      gate.run("write", async () => "must not run"),
    ).rejects.toMatchObject({
      code: "browser_busy",
    });
    const state = await store.list();
    expect(state.activity).toMatchObject({
      readers: { [token]: { pid: process.pid } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
