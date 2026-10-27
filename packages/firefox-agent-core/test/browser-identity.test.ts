import { describe, expect, it } from "vitest";
import { getLocalFirefoxEpoch } from "../src/browser-identity.js";

describe("local Firefox process epoch", () => {
  it("returns only an opaque epoch or null", async () => {
    const epoch = await getLocalFirefoxEpoch();
    expect(epoch === null || /^[a-f0-9]{64}$/u.test(epoch)).toBe(true);
  });
});
