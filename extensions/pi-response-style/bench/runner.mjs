// Runner: spawns pi in print mode under full isolation, and runs the hidden
// coding tests.
//
// Isolation (hard constraint): every pi invocation gets a fresh temp
// PI_CODING_AGENT_DIR and a fresh temp cwd, so it never touches the user's
// real ~/.pi/agent sessions, settings, response-styles, or state. The only
// read of the real agent dir is a one-time, read-only lookup of the bench
// provider's definition in ~/.pi/agent/models.json — necessary because the
// fireworks-kimi gateway provider is not built in. That provider uses a
// dummy API key (real auth is network-level at the gateway), so no secret is
// copied. Nothing is ever written to the real agent dir.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "fireworks-kimi/kimi-k3-fast";
export const DEFAULT_STYLE = "simplicity";
export const PI_BIN = process.env.BENCH_PI_BIN || "pi";

/**
 * Read the bench provider's definition from the real agent dir once.
 * Returns { provider, def }; throws clearly if the provider is unknown so
 * the caller can set BENCH_MODEL to a provider that exists.
 */
export function loadProviderDef(model) {
  const provider = model.includes("/") ? model.split("/")[0] : model;
  const realModels = join(homedir(), ".pi", "agent", "models.json");
  if (!existsSync(realModels)) {
    throw new Error(
      `Cannot resolve bench provider: no models.json at ${realModels}. ` +
        `Set BENCH_MODEL to a built-in provider or seed a models.json.`,
    );
  }
  const parsed = JSON.parse(readFileSync(realModels, "utf8"));
  const def = parsed.providers?.[provider];
  if (!def) {
    throw new Error(
      `Provider "${provider}" (for model "${model}") not found in ${realModels}. ` +
        `Available: ${Object.keys(parsed.providers ?? {}).join(", ")}`,
    );
  }
  return { provider, def };
}

/** Fresh temp agent dir seeded with a minimal models.json (bench provider only). */
export function freshAgentDir(providerDef) {
  const dir = mkdtempSync(join(tmpdir(), "pi-bench-agent-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify(
      { providers: { [providerDef.provider]: providerDef.def } },
      null,
      2,
    ),
  );
  return dir;
}

export function freshCwd() {
  return mkdtempSync(join(tmpdir(), "pi-bench-cwd-"));
}

/** Pre-seed lastUsed so the extension resolves the style at session start. */
export function seedStyleState(agentDir, styleName) {
  writeFileSync(
    join(agentDir, "pi-response-style.state.json"),
    JSON.stringify({ lastUsed: styleName }) + "\n",
  );
}

// Shared flag set for both arms. The ONLY difference between arms is the
// -e extension path on the ON arm, so any output delta is attributable to
// the style injection alone. --no-tools/--no-context-files keep the system
// prompt identical apart from the injected style body.
function buildArgs(prompt, model, extensionPath) {
  const args = [
    "-p",
    prompt,
    "--model",
    model,
    "--no-session",
    "--no-extensions",
    "--no-tools",
    "--no-context-files",
  ];
  if (extensionPath) args.push("-e", extensionPath);
  return args;
}

/** Run one pi print-mode invocation under isolation. */
export function runPi({
  prompt,
  model,
  agentDir,
  cwd,
  extensionPath,
  timeoutMs,
}) {
  const args = buildArgs(prompt, model, extensionPath);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  return new Promise((resolve) => {
    const child = spawn(PI_BIN, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        reply: "",
        stderr: String(err),
        exitCode: -1,
        timedOut: false,
        spawnError: String(err),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ reply: stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
}

/** Run one arm of one case: fresh dirs, seed, run, clean up. */
export async function runArm({
  caseDef,
  model,
  styleName,
  extensionPath,
  providerDef,
  arm,
  timeoutMs,
}) {
  const agentDir = freshAgentDir(providerDef);
  const cwd = freshCwd();
  if (arm === "on") {
    seedStyleState(agentDir, styleName);
  }
  const extPath = arm === "on" ? extensionPath : undefined;
  const start = Date.now();
  const result = await runPi({
    prompt: caseDef.prompt,
    model,
    agentDir,
    cwd,
    extensionPath: extPath,
    timeoutMs,
  });
  const elapsedMs = Date.now() - start;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  return { arm, ...result, elapsedMs };
}

/** Extract the first fenced code block. Falls back to null if none found. */
export function extractCodeBlock(reply) {
  const fence = /```(?:[a-zA-Z]+)?\r?\n([\s\S]*?)```/;
  const m = reply.match(fence);
  if (m) return { code: m[1], method: "fence" };
  return { code: null, method: "none" };
}

// Strip ESM `export` keywords so a snippet runs as CommonJS. The prompts ask
// for a plain function with no exports, but this neutralizes any stray
// `export function`/`export const`/`export default` the model adds.
function normalizeJsForCjs(code) {
  return code
    .replace(/^export\s+default\s+/gm, "")
    .replace(/^export\s+/gm, "")
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "");
}

/**
 * Run a hidden coding test against an extracted snippet. Concatenates the
 * (normalized) snippet with the test code and runs it with node. The temp
 * dir has no package.json, so .js is treated as CommonJS.
 */
export function runCodingTest(extracted, testCode) {
  if (!extracted.code) {
    return Promise.resolve({
      passes: false,
      exitCode: -1,
      output: "no fenced code block in reply",
      extractionMethod: extracted.method,
    });
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-bench-code-"));
  const file = join(dir, "solution.js");
  writeFileSync(file, `${normalizeJsForCjs(extracted.code)}\n${testCode}\n`);
  return new Promise((resolve) => {
    const child = spawn("node", [file], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({
        passes: false,
        exitCode: -1,
        output: String(e),
        extractionMethod: extracted.method,
      });
    });
    child.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({
        passes: (code ?? -1) === 0,
        exitCode: code ?? -1,
        output: (out + err).slice(-600),
        extractionMethod: extracted.method,
      });
    });
  });
}
