import { describe, expect, test } from "vitest";
import {
  assignmentMarker,
  DeliveryTracker,
  formatAssignmentPrompt,
  formatSteerPrompt,
} from "../src/_managed-delivery.ts";

const prompt = (id: string) => formatAssignmentPrompt(id, "task");

describe("delivery tracker", () => {
  test("our idle echo lets an unmarked run start claim the prompt; foreign input revokes it", () => {
    const tracker = new DeliveryTracker();
    tracker.sendPrompt("a1", 100);
    expect(tracker.claimRunStart("transformed")).toBeUndefined();
    tracker.observeInput(prompt("a1"), "extension", "idle");
    expect(tracker.pendingPrompt?.phase).toBe("echoedIdle");
    tracker.observeInput("typed", "interactive", "idle");
    expect(tracker.pendingPrompt?.phase).toBe("sent");
    tracker.observeInput(prompt("a1"), "extension", "idle");
    expect(tracker.claimRunStart("transformed")).toBe("a1");
    expect(tracker.pendingPrompt).toBeUndefined();
  });

  test("a busy echo queues the prompt: no start deadline, only marked starts claim it", () => {
    const tracker = new DeliveryTracker();
    tracker.sendPrompt("a1", 100);
    tracker.observeInput(prompt("a1"), "extension", "busy");
    tracker.observeInput("typed", "interactive", "idle");
    tracker.observeInput(prompt("a1"), "extension", "idle");
    expect(tracker.pendingPrompt?.phase).toBe("queued");
    expect(tracker.takeOverdue(10_000)).toBeUndefined();
    expect(tracker.claimRunStart("transformed")).toBeUndefined();
    expect(tracker.claimMessage(`${assignmentMarker("a1")}\ntask`)).toBe("a1");
  });

  test("deadlines extend for compaction and expire unstarted prompts once", () => {
    const tracker = new DeliveryTracker();
    tracker.sendPrompt("a1", 100);
    tracker.extendDeadline(50);
    expect(tracker.takeOverdue(100)).toBeUndefined();
    tracker.extendDeadline(500);
    expect(tracker.takeOverdue(400)).toBeUndefined();
    tracker.resetDeadline(450);
    expect(tracker.takeOverdue(451)).toBe("a1");
    expect(tracker.takeOverdue(452)).toBeUndefined();
    tracker.markExpired("a1");
    expect(tracker.takeExpiredIn("unrelated")).toBeUndefined();
    expect(tracker.takeExpiredIn(prompt("a1"))).toBe("a1");
    expect(tracker.takeExpiredIn(prompt("a1"))).toBeUndefined();
  });

  test("steers match by their own marker and are taken once", () => {
    const tracker = new DeliveryTracker();
    tracker.addSteer("s1");
    tracker.addSteer("s2");
    expect(tracker.takeSteersIn(formatSteerPrompt("a1", "s2", "x"))).toEqual([
      "s2",
    ]);
    expect(tracker.takeSteersIn(formatSteerPrompt("a1", "s2", "x"))).toEqual(
      [],
    );
    tracker.dropSteer("s1");
    expect(tracker.takeSteersIn(formatSteerPrompt("a1", "s1", "x"))).toEqual(
      [],
    );
  });

  test("drops pending steers and a queued prompt only after Pi stays drained for the grace window", () => {
    const tracker = new DeliveryTracker();
    expect(tracker.takeDropped(0, "drained", 10)).toBeUndefined();
    tracker.addSteer("s1");
    tracker.sendPrompt("a2", 100);
    tracker.observeInput(prompt("a2"), "extension", "busy");
    expect(tracker.takeDropped(0, "drained", 10)).toBeUndefined();
    // Activity resets the quiet window.
    expect(tracker.takeDropped(5, "active", 10)).toBeUndefined();
    expect(tracker.takeDropped(12, "drained", 10)).toBeUndefined();
    expect(tracker.takeDropped(22, "drained", 10)).toEqual({
      steerIds: ["s1"],
      queuedPromptId: "a2",
    });
    expect(tracker.takeSteersIn(formatSteerPrompt("a1", "s1", "x"))).toEqual(
      [],
    );
  });
});
