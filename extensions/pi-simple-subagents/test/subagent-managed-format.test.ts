import { describe, expect, test } from "vitest";
import {
  footerWorkerLabel,
  stateLabel,
  workerIdentity,
  workerLabel,
} from "../src/_managed-format.ts";
import type { ManagedWorkerView } from "../src/_managed.ts";

function worker(overrides: Partial<ManagedWorkerView> = {}): ManagedWorkerView {
  // SAFETY: these formatters read only the fields set here.
  return {
    handle: "mw-aaaaaa",
    agent: { name: "coder", source: "user" },
    lifecycle: "running",
    live: true,
    childState: "idle",
    lastAssignmentId: "a-1",
    recentAssignments: [],
    ...overrides,
  } as ManagedWorkerView;
}

describe("managed worker formatting", () => {
  test("defaults the emoji and includes the profile only when set", () => {
    expect(workerIdentity(worker())).toBe("🤖 coder");
    expect(
      workerIdentity(
        worker({
          agent: { name: "coder", emoji: "🧪", source: "user" },
          profile: "quick",
        }),
      ),
    ).toBe("🧪 coder · quick");
  });

  test("labels put identity first in the picker and state first in the footer", () => {
    const view = worker({ profile: "quick" });
    expect(workerLabel(view)).toBe("🤖 coder · quick · idle · mw-aaaaaa");
    expect(footerWorkerLabel(view)).toBe("🤖 quick · idle · coder · mw-aaaaaa");
    expect(
      footerWorkerLabel(
        worker({ agent: { name: "two\nlines", source: "user" } }),
      ),
    ).toBe("🤖 · idle · two lines · mw-aaaaaa");
  });

  test("state reflects the latest assignment over the worker lifecycle", () => {
    const assignment = {
      handle: "mw-aaaaaa",
      id: "a-1",
      preview: "task",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
        contextTokens: 0,
      },
      toolActivity: false,
    };
    expect(
      stateLabel(
        worker({
          recentAssignments: [
            { ...assignment, state: "running", terminal: false },
          ],
        }),
      ),
    ).toBe("running");
    expect(
      stateLabel(
        worker({
          live: false,
          lifecycle: "exited",
          recentAssignments: [
            { ...assignment, state: "completed", terminal: true },
          ],
        }),
      ),
    ).toBe("completed · exited");
  });
});
