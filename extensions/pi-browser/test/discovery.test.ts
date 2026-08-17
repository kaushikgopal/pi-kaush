import { describe, expect, test } from "vitest";
import { parsePortFile } from "../src/core/discovery.ts";

describe("parsePortFile", () => {
  test("parses the two-line DevToolsActivePort format", () => {
    expect(
      parsePortFile(
        "9222\n/devtools/browser/880ff596-0fe3-4574-98b9-8a8b69ee8338\n",
      ),
    ).toEqual({
      port: 9222,
      path: "/devtools/browser/880ff596-0fe3-4574-98b9-8a8b69ee8338",
    });
  });

  test("rejects a missing ws path", () => {
    expect(parsePortFile("9222\n")).toBeNull();
    expect(parsePortFile("")).toBeNull();
  });

  test("rejects out-of-range and non-numeric ports", () => {
    expect(parsePortFile("0\n/devtools/browser/x")).toBeNull();
    expect(parsePortFile("99999\n/devtools/browser/x")).toBeNull();
    expect(parsePortFile("abc\n/devtools/browser/x")).toBeNull();
  });
});
