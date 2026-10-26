import { afterEach, describe, expect, it } from "vitest";
import {
  createFirefoxClient,
  SUPPORTED_FIREFOX_CLI_VERSION,
} from "../src/index.js";
import type { FirefoxClientOptions } from "../src/index.js";

const doctorPayload = {
  nativeHostManifest: {
    status: "installed",
    path: "/private/native-host.json",
  },
  nativeHostRegistration: {
    status: "installed",
    path: "/private/registration",
  },
  extensionConnection: {
    status: "connected",
    nextAction: "connect at https://private.invalid/token",
  },
};

afterEach(() => {
  delete process.env.FIREFOX_CORE_FIXTURE_MODE;
});

describe("Firefox status", () => {
  it("runs version and doctor with safe status projection", async () => {
    const calls: string[][] = [];
    const client = createFirefoxClient({
      transport: async (_binaryPath, args) => {
        calls.push([...args]);
        return args[0] === "--version"
          ? { stdout: "0.4.1\n", stderr: "", exitCode: 0 }
          : { stdout: JSON.stringify(doctorPayload), stderr: "", exitCode: 1 };
      },
    });

    await expect(client.status()).resolves.toEqual({
      ok: true,
      result: {
        cliVersion: "0.4.1",
        supportedVersion: "0.4.1",
        versionMatches: true,
        nativeHost: "installed",
        connection: "connected",
        warnings: [],
      },
    });
    expect(calls).toEqual([["--version"], ["doctor", "--json"]]);
  });

  it("warns on a safe version mismatch and folds registration health", async () => {
    const client = createFirefoxClient({
      transport: async (_binaryPath, args) =>
        args[0] === "--version"
          ? { stdout: "0.5.0\n", stderr: "", exitCode: 0 }
          : {
              stdout: JSON.stringify({
                nativeHostManifest: { status: "installed" },
                nativeHostRegistration: { status: "stale" },
                extensionConnection: { status: "not-approved" },
              }),
              stderr: "",
              exitCode: 1,
            },
    });

    await expect(client.status()).resolves.toEqual({
      ok: true,
      result: {
        cliVersion: "0.5.0",
        supportedVersion: SUPPORTED_FIREFOX_CLI_VERSION,
        versionMatches: false,
        nativeHost: "stale",
        connection: "not-approved",
        warnings: ["Supported firefox-cli version is 0.4.1; detected 0.5.0."],
      },
    });
  });

  it("rejects unknown doctor statuses without exposing raw output", async () => {
    const secret = "/Users/kaushik/private/token";
    const client = createFirefoxClient({
      transport: async (_binaryPath, args) =>
        args[0] === "--version"
          ? { stdout: "0.4.1", stderr: "", exitCode: 0 }
          : {
              stdout: JSON.stringify({
                nativeHostManifest: { status: "private", path: secret },
                extensionConnection: {
                  status: "connected",
                  nextAction: secret,
                },
              }),
              stderr: secret,
              exitCode: 0,
            },
    });

    const result = await client.status();
    expect(result).toMatchObject({
      ok: false,
      code: "invalid_doctor_response",
      recovery: null,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects version text that could contain arbitrary output", async () => {
    const client = createFirefoxClient({
      transport: async () => ({
        stdout: "0.4.1 /private/token",
        stderr: "/private/token",
        exitCode: 0,
      }),
    });

    const result = await client.status();
    expect(result).toMatchObject({ ok: false, code: "invalid_cli_version" });
    expect(JSON.stringify(result)).not.toContain("/private/token");
  });

  it("maps transport exceptions and missing executables to values", async () => {
    const throwingClient = createFirefoxClient({
      transport: async () => {
        throw new Error("/private/path/with-token");
      },
    });
    const throwingResult = await throwingClient.status();
    expect(throwingResult).toMatchObject({
      ok: false,
      code: "cli_transport_failed",
    });
    expect(JSON.stringify(throwingResult)).not.toContain("/private");

    const missingClient = createFirefoxClient({
      transport: async () => ({
        stdout: "",
        stderr: "/private/path",
        exitCode: null,
        error: "not-found",
      }),
    });
    await expect(missingClient.status()).resolves.toMatchObject({
      ok: false,
      code: "cli_not_found",
    });
  });

  it("does not invoke the transport for an already-aborted signal", async () => {
    let invoked = false;
    const controller = new AbortController();
    controller.abort();
    const client = createFirefoxClient({
      transport: async () => {
        invoked = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      client.status({ signal: controller.signal }),
    ).resolves.toMatchObject({
      ok: false,
      code: "aborted",
    });
    expect(invoked).toBe(false);
  });

  it("validates bounded client options without exposing binary paths", async () => {
    const options = {
      binaryPath: "/private/tokenized/path",
      timeoutMs: 0,
    } as FirefoxClientOptions;
    const result = await createFirefoxClient(options).status();

    expect(result).toMatchObject({ ok: false, code: "invalid_options" });
    expect(JSON.stringify(result)).not.toContain(options.binaryPath);
  });
});

describe("local process transport", () => {
  const fixturePath = new URL(
    "./fixtures/fake-firefox-cli.mjs",
    import.meta.url,
  );

  it("runs the local child fixture with shell disabled", async () => {
    process.env.FIREFOX_CORE_FIXTURE_MODE = "normal";
    const client = createFirefoxClient({
      binaryPath: fixturePath.pathname,
      timeoutMs: 2_000,
    });

    await expect(client.status()).resolves.toMatchObject({
      ok: true,
      result: { cliVersion: "0.4.1", connection: "connected" },
    });
  });

  it("bounds real child stdout and stderr", async () => {
    process.env.FIREFOX_CORE_FIXTURE_MODE = "stream";
    const result = await createFirefoxClient({
      binaryPath: fixturePath.pathname,
      timeoutMs: 2_000,
      maxOutputBytes: 64,
    }).status();

    expect(result).toMatchObject({ ok: false, code: "output_limit" });
  });

  it("times out and kills a real child process", async () => {
    process.env.FIREFOX_CORE_FIXTURE_MODE = "hang";
    const result = await createFirefoxClient({
      binaryPath: fixturePath.pathname,
      timeoutMs: 50,
    }).status();

    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });

  it("cancels a real child process", async () => {
    process.env.FIREFOX_CORE_FIXTURE_MODE = "cancel";
    const controller = new AbortController();
    const promise = createFirefoxClient({
      binaryPath: fixturePath.pathname,
      timeoutMs: 2_000,
    }).status({ signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    await expect(promise).resolves.toMatchObject({
      ok: false,
      code: "aborted",
    });
  });
});
