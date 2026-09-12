import { describe, expect, test } from "vitest";
import { SessionConcurrencyGate } from "../src/_concurrency.ts";

describe("SessionConcurrencyGate", () => {
  test("queues above the active limit and releases slots on completion", async () => {
    const gate = new SessionConcurrencyGate(2);
    const releaseFirst = await gate.acquire();
    const releaseSecond = await gate.acquire();
    let thirdStarted = false;
    const third = gate.acquire().then((release) => {
      thirdStarted = true;
      return release;
    });

    expect(gate.status).toEqual({
      active: 2,
      queued: 1,
      limit: 2,
      available: 0,
    });
    await Promise.resolve();
    expect(thirdStarted).toBe(false);

    releaseFirst();
    const releaseThird = await third;
    expect(thirdStarted).toBe(true);
    expect(gate.status).toEqual({
      active: 2,
      queued: 0,
      limit: 2,
      available: 0,
    });

    releaseSecond();
    releaseThird();
    expect(gate.status).toEqual({
      active: 0,
      queued: 0,
      limit: 2,
      available: 2,
    });
  });

  test("does not cap cumulative acquisitions", async () => {
    const gate = new SessionConcurrencyGate(1);
    for (let i = 0; i < 20; i++) {
      const release = await gate.acquire();
      expect(gate.status.active).toBe(1);
      release();
    }
    expect(gate.status).toMatchObject({ active: 0, queued: 0, available: 1 });
  });

  test("rejects queued acquisitions when aborted", async () => {
    const gate = new SessionConcurrencyGate(1);
    const release = await gate.acquire();
    const controller = new AbortController();
    const queued = gate.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toThrow("aborted before it started");
    expect(gate.status.queued).toBe(0);
    release();
  });

  test("rejects queued and future acquisitions after close", async () => {
    const gate = new SessionConcurrencyGate(1);
    const release = await gate.acquire();
    const queued = gate.acquire();
    gate.close();

    await expect(queued).rejects.toThrow("session is shutting down");
    await expect(gate.acquire()).rejects.toThrow("session is shutting down");
    release();
    expect(gate.status.active).toBe(0);
  });
});
