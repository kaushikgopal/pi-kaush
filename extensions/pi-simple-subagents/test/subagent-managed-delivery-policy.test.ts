import { describe, expect, test } from "vitest";
import {
  acknowledgeInFlight,
  MAX_ATTEMPTS,
  MAX_REPORTS_PER_MESSAGE,
  nextDelivery,
  planBatch,
  RETRY_MS,
  reportKey,
  selectBatch,
  SETTLE_RETRY_MS,
  settleInFlight,
  startInFlight,
  type DeliveryLedger,
  type ReportKey,
} from "../src/_managed-delivery-policy.ts";

const subject = (id: string) => ({ handle: "mw-aaaaaa", id });
const key = (id: string) => reportKey("mw-aaaaaa", id);

function ledger(
  received: readonly ReportKey[] = [],
  attempts: readonly (readonly [ReportKey, number])[] = [],
): DeliveryLedger {
  return { received: new Set(received), attempts: new Map(attempts) };
}

describe("managed delivery policy", () => {
  test("selects unacknowledged results under the attempt cap, resending only while idle", () => {
    const results = ["fresh", "received", "retry", "capped"].map(subject);
    const state = ledger(
      [key("received")],
      [
        [key("retry"), 1],
        [key("capped"), MAX_ATTEMPTS],
      ],
    );

    expect(selectBatch(results, state, "idle").map((r) => r.id)).toEqual([
      "fresh",
      "retry",
    ]);
    // An earlier send may still sit in a busy parent's queue.
    expect(selectBatch(results, state, "busy").map((r) => r.id)).toEqual([
      "fresh",
    ]);
  });

  test("batches at most ten reports per message", () => {
    const results = Array.from({ length: 12 }, (_, index) =>
      subject(`a-${index}`),
    );
    const plan = planBatch(results, ledger(), "idle", "normal");
    expect(plan._tag).toBe("send");
    if (plan._tag !== "send") return;
    expect(plan.batch).toHaveLength(MAX_REPORTS_PER_MESSAGE);
    expect(plan.batch[0].id).toBe("a-0");
  });

  test("a retry after an aborted run is quiet; fresh and normal sends trigger a turn", () => {
    const retry = ledger([], [[key("a-1"), 1]]);
    const turnOf = (state: DeliveryLedger, lastRun: "aborted" | "normal") => {
      const plan = planBatch([subject("a-1")], state, "idle", lastRun);
      return plan._tag === "send" ? plan.turn : plan._tag;
    };
    expect(turnOf(retry, "aborted")).toBe("quiet");
    expect(turnOf(retry, "normal")).toBe("trigger");
    expect(turnOf(ledger(), "aborted")).toBe("trigger");
    expect(turnOf(ledger([key("a-1")]), "normal")).toBe("none");
  });

  test("an in-flight message waits while busy and until acknowledged or due", () => {
    const inFlight = startInFlight([key("a-1"), key("a-2")], 1_000);
    expect(inFlight.retryAt).toBe(1_000 + RETRY_MS);

    expect(nextDelivery(undefined, ledger(), "busy", 0)).toEqual({
      _tag: "ready",
    });
    // A busy parent may still deliver it, even past the deadline.
    expect(
      nextDelivery(inFlight, ledger(), "busy", inFlight.retryAt + 1),
    ).toEqual({ _tag: "wait", inFlight });

    const partly = nextDelivery(inFlight, ledger([key("a-1")]), "idle", 2_000);
    expect(partly).toEqual({
      _tag: "wait",
      inFlight: { keys: new Set([key("a-2")]), retryAt: inFlight.retryAt },
    });
    expect(
      nextDelivery(inFlight, ledger([key("a-1"), key("a-2")]), "idle", 2_000),
    ).toEqual({ _tag: "ready" });
    expect(nextDelivery(inFlight, ledger(), "idle", inFlight.retryAt)).toEqual({
      _tag: "ready",
    });
  });

  test("settling pulls the retry forward but never pushes it back", () => {
    const inFlight = startInFlight([key("a-1")], 0);
    expect(settleInFlight(inFlight, 5_000).retryAt).toBe(
      5_000 + SETTLE_RETRY_MS,
    );
    const soon = { keys: inFlight.keys, retryAt: 100 };
    expect(settleInFlight(soon, 5_000).retryAt).toBe(100);
  });

  test("acknowledging every key clears the in-flight message", () => {
    const inFlight = startInFlight([key("a-1"), key("a-2")], 0);
    expect(acknowledgeInFlight(inFlight, [key("a-1")])?.keys).toEqual(
      new Set([key("a-2")]),
    );
    expect(
      acknowledgeInFlight(inFlight, [key("a-1"), key("a-2")]),
    ).toBeUndefined();
    expect(acknowledgeInFlight(undefined, [key("a-1")])).toBeUndefined();
  });
});
