import { describe, expect, it } from "vitest";
import { parseCaptureExportArgs } from "../src/capture-export-args.ts";
import {
  filterCapturedExchanges,
  hostnameOf,
  matchesCapturedDomains,
} from "../src/core/capture.ts";
import {
  markPersistedGraphQLExchange,
  persistedGraphQLOperationName,
  restorePersistedGraphQLBody,
  stripPseudoHeaders,
} from "../src/core/capture-export.ts";
import { SkillGenerator, type CapturedExchange } from "@apitap/core";

interface MiniExchange {
  seq: number;
  request: { url: string };
  response: { status: number };
}

const exchange = (seq: number, url: string, status: number): MiniExchange => ({
  seq,
  request: { url },
  response: { status },
});

describe("hostnameOf", () => {
  it("extracts lowercase hostnames, dropping ports", () => {
    expect(hostnameOf("https://Api.GitHub.com/foo?q=1")).toBe("api.github.com");
    expect(hostnameOf("http://localhost:8080/x")).toBe("localhost");
  });

  it("returns empty string for unparsable URLs", () => {
    expect(hostnameOf("not a url")).toBe("");
  });
});

describe("stripPseudoHeaders", () => {
  it("removes HTTP/2 pseudo-headers while preserving ordinary headers", () => {
    expect(
      stripPseudoHeaders({
        ":authority": "api.example.com",
        authorization: "Bearer token",
        host: "api.example.com",
      }),
    ).toEqual({ authorization: "Bearer token", host: "api.example.com" });
  });
});

describe("persisted GraphQL compatibility", () => {
  const postData = JSON.stringify({
    variables: { showUri: "spotify:show:example" },
    operationName: "getEpisodeList",
    extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } },
  });
  const captured: CapturedExchange = {
    request: {
      url: "https://creators-graph.spotify.com/v2/graph-pq",
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        authorization: "Bearer secret",
      },
      postData,
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { episodes: [] } }),
      contentType: "application/json",
    },
    timestamp: new Date(0).toISOString(),
  };

  it("detects persisted operation names without treating ordinary JSON as GraphQL", () => {
    expect(persistedGraphQLOperationName(postData)).toBe("getEpisodeList");
    expect(persistedGraphQLOperationName(JSON.stringify({ operationName: "x" }))).toBe(
      null,
    );
  });

  it("keeps the original persisted body while giving the generator an operation key", () => {
    const generator = new SkillGenerator({ scrub: true, enablePreview: false });
    const endpoint = generator.addExchange(markPersistedGraphQLExchange(captured));
    expect(endpoint?.id).toBe("post-graphql-getEpisodeList");
    expect(endpoint?.requestBody?.template).toEqual(expect.any(String));
    const restored = restorePersistedGraphQLBody(endpoint!);
    expect(JSON.parse(restored.requestBody?.template as string)).toEqual(JSON.parse(postData));
  });
});

describe("matchesCapturedDomains", () => {
  it("matches exact domains", () => {
    expect(matchesCapturedDomains("api.github.com", ["api.github.com"])).toBe(
      true,
    );
    expect(matchesCapturedDomains("github.com", ["api.github.com"])).toBe(
      false,
    );
  });

  it("matches *.example.com against the bare domain and any subdomain", () => {
    const patterns = ["*.example.com"];
    expect(matchesCapturedDomains("example.com", patterns)).toBe(true);
    expect(matchesCapturedDomains("api.example.com", patterns)).toBe(true);
    expect(matchesCapturedDomains("a.b.example.com", patterns)).toBe(true);
  });

  it("never matches evil-suffix lookalikes", () => {
    const patterns = ["*.example.com", "github.com"];
    expect(matchesCapturedDomains("evilexample.com", patterns)).toBe(false);
    expect(matchesCapturedDomains("github.com.evil.net", patterns)).toBe(false);
    expect(matchesCapturedDomains("notgithub.com", patterns)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesCapturedDomains("API.GITHUB.COM", ["*.github.com"])).toBe(
      true,
    );
    expect(matchesCapturedDomains("api.example.com", ["*.EXAMPLE.COM"])).toBe(
      true,
    );
  });

  it("matches any pattern in the list, and an empty list matches all", () => {
    expect(
      matchesCapturedDomains("other.com", ["a.com", "*.b.com", "other.com"]),
    ).toBe(true);
    expect(matchesCapturedDomains("anything.org", [])).toBe(true);
  });
});

describe("filterCapturedExchanges", () => {
  const raw = [
    exchange(1, "https://api.github.com/users", 200),
    exchange(2, "https://example.com/", 200),
    exchange(3, "https://api.github.com/teams", 404),
    exchange(4, "https://cdn.example.com/app.js", 200),
  ];

  it("keeps completed exchanges only (status > 0)", () => {
    const out = filterCapturedExchanges(
      [
        ...raw,
        exchange(5, "https://api.github.com/failed", 0),
        exchange(6, "https://api.github.com/failed2", -1),
      ],
      {},
    );
    expect(out.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("applies sinceSeq exclusively and minStatus inclusively", () => {
    const bySeq = filterCapturedExchanges(raw.slice(0, 3), { sinceSeq: 1 });
    expect(bySeq.map((e) => e.seq)).toEqual([2, 3]);
    const byStatus = filterCapturedExchanges(raw.slice(0, 3), {
      minStatus: 400,
    });
    expect(byStatus.map((e) => e.seq)).toEqual([3]);
  });

  it("filters by exact domains", () => {
    const out = filterCapturedExchanges(raw, {
      domains: ["api.github.com"],
    });
    expect(out.map((e) => e.seq)).toEqual([1, 3]);
  });

  it("filters by wildcard domains across hosts", () => {
    const out = filterCapturedExchanges(raw, { domains: ["*.example.com"] });
    expect(out.map((e) => e.seq)).toEqual([2, 4]);
  });

  it("combines domain and status filters", () => {
    const out = filterCapturedExchanges(raw, {
      domains: ["*.github.com"],
      minStatus: 300,
    });
    expect(out.map((e) => e.seq)).toEqual([3]);
  });

  it("leaves everything in when no filters are given", () => {
    expect(filterCapturedExchanges(raw, {})).toEqual(raw);
  });
});

describe("parseCaptureExportArgs", () => {
  it("returns no filters for bare invocation", () => {
    expect(parseCaptureExportArgs([])).toEqual({ ok: true, args: {} });
  });

  it("parses all flags", () => {
    expect(
      parseCaptureExportArgs([
        "--session",
        "checkout",
        "--domain",
        "api.github.com,*.example.com",
        "--since-seq",
        "7",
        "--min-status",
        "400",
        "--json",
      ]),
    ).toEqual({
      ok: true,
      args: {
        session: "checkout",
        domain: "api.github.com,*.example.com",
        sinceSeq: 7,
        minStatus: 400,
        json: true,
      },
    });
  });

  it("rejects missing or empty flag values", () => {
    expect(parseCaptureExportArgs(["--session"])).toEqual({
      ok: false,
      error: "--session needs a value",
    });
    expect(parseCaptureExportArgs(["--domain", ""])).toEqual({
      ok: false,
      error: "--domain needs a value",
    });
    expect(parseCaptureExportArgs(["--since-seq"])).toEqual({
      ok: false,
      error: "--since-seq needs a value",
    });
  });

  it("rejects non-integer and negative numerics", () => {
    expect(parseCaptureExportArgs(["--since-seq", "abc"])).toEqual({
      ok: false,
      error: "--since-seq must be a non-negative integer",
    });
    expect(parseCaptureExportArgs(["--min-status", "-1"])).toEqual({
      ok: false,
      error: "--min-status must be a non-negative integer",
    });
    expect(parseCaptureExportArgs(["--since-seq", "1.5"])).toEqual({
      ok: false,
      error: "--since-seq must be a non-negative integer",
    });
  });

  it("rejects unknown flags", () => {
    expect(parseCaptureExportArgs(["--bogus"])).toEqual({
      ok: false,
      error: "unknown flag: --bogus",
    });
  });
});
