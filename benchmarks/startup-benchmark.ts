#!/usr/bin/env bun

import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";

const DEFAULT_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const ANSI_PATTERN =
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

export interface ExtensionTiming {
  path: string;
  importMs: number;
  factoryMs: number;
}

export interface StartupTiming {
  totalMs: number;
  extensions: Map<string, ExtensionTiming>;
}

export interface ExtensionBenchmark {
  name: string;
  path: string;
  importMs: number;
  isolatedTotalMs: number;
  overheadMs: number;
  error?: string;
}

export interface DirectoryBenchmark {
  label: string;
  cwd: string;
  runs: number;
  fullMs: number;
  noExtensionsMs: number;
  welcomeImportMs?: number;
  extensions: ExtensionBenchmark[];
}

interface CliOptions {
  runs: number;
  scope: "both" | "current" | "home";
  timeoutMs: number;
}

interface RunOptions {
  cwd: string;
  timeoutMs: number;
  noExtensions?: boolean;
  extensionPath?: string;
}

export const EXPECT_SCRIPT = `
set timeout $env(PI_BENCH_TIMEOUT_SECONDS)
match_max 1000000
set command [list env PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TIMING=1 PI_STARTUP_BENCHMARK=1 pi]
if {$env(PI_BENCH_NO_EXTENSIONS) eq "1"} {
  lappend command --no-extensions
}
if {$env(PI_BENCH_EXTENSION) ne ""} {
  lappend command --extension $env(PI_BENCH_EXTENSION)
}
spawn -noecho {*}$command
set saw_extension_timings 0
set completed 0
expect {
  -re {--- Startup Timings: extensions ---} {
    set saw_extension_timings 1
    exp_continue
  }
  -re {\\r?\\n-+\\r?\\n} {
    if {$saw_extension_timings} {
      set completed 1
    } else {
      exp_continue
    }
  }
  timeout { exit 124 }
  eof {}
}
if {$completed} {
  # Extensions can leave background handles open after Pi finishes startup.
  # Stop the process once the complete timing report has reached the PTY.
  catch {exec kill -TERM [exp_pid]}
  expect {
    eof {}
    timeout {}
  }
  catch {wait}
  exit 0
}
set result [wait]
exit [lindex $result 3]
`;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "").replaceAll("\r", "");
}

function parseSection(text: string, name: string): string | undefined {
  const marker = `--- Startup Timings: ${name} ---`;
  const start = text.indexOf(marker);
  if (start === -1) return undefined;
  const bodyStart = start + marker.length;
  const end = text.indexOf("\n---", bodyStart);
  return text.slice(bodyStart, end === -1 ? undefined : end);
}

export function parseStartupTiming(rawOutput: string): StartupTiming {
  const output = stripAnsi(rawOutput);
  const mainSection = parseSection(output, "main");
  const totalMatch = mainSection?.match(/^\s*TOTAL:\s*([\d.]+)ms\s*$/m);
  if (!totalMatch)
    throw new Error("Pi did not emit a main startup TOTAL timing");

  const extensions = new Map<string, ExtensionTiming>();
  const extensionSection = parseSection(output, "extensions");
  if (extensionSection) {
    for (const match of extensionSection.matchAll(
      /^\s*(.+?) module import:\s*([\d.]+)ms\s*$/gm,
    )) {
      const path = match[1];
      extensions.set(path, {
        path,
        importMs: Number(match[2]),
        factoryMs: 0,
      });
    }

    for (const match of extensionSection.matchAll(
      /^\s*(.+?) factory:\s*([\d.]+)ms\s*$/gm,
    )) {
      const timing = extensions.get(match[1]);
      if (timing) timing.factoryMs = Number(match[2]);
    }
  }

  return {
    totalMs: Number(totalMatch[1]),
    extensions,
  };
}

export function median(values: number[]): number {
  if (values.length === 0)
    throw new Error("Cannot calculate a median without values");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}${sep}`)) return `~${sep}${relative(home, path)}`;
  return path;
}

export function extensionName(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const nodeModulesMarker = "/node_modules/";
  const nodeModulesIndex = normalized.lastIndexOf(nodeModulesMarker);
  if (nodeModulesIndex !== -1) {
    const packagePath = normalized.slice(
      nodeModulesIndex + nodeModulesMarker.length,
    );
    const parts = packagePath.split("/");
    return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  }

  const extensionMarker = "/extensions/";
  const extensionIndex = normalized.lastIndexOf(extensionMarker);
  if (extensionIndex !== -1) {
    const extensionPath = normalized
      .slice(extensionIndex + extensionMarker.length)
      .replace(/\.(?:js|mjs|cjs|ts|mts|cts)$/, "");
    return extensionPath.replace(/\/src\/index$/, "");
  }

  return basename(normalized).replace(/\.(?:js|mjs|cjs|ts|mts|cts)$/, "");
}

export function isWelcomeScreenPath(path: string): boolean {
  const name = extensionName(path);
  return (
    name === "welcome-screen" ||
    name === "pi-welcome-screen" ||
    name === "@pi-kaush/pi-welcome-screen"
  );
}

function formatMilliseconds(milliseconds: number): string {
  if (milliseconds >= 1_000) return `${(milliseconds / 1_000).toFixed(2)}s`;
  return `${Math.round(milliseconds)}ms`;
}

function formatRatio(milliseconds: number, totalMs: number): string {
  const percent = totalMs > 0 ? (milliseconds / totalMs) * 100 : 0;
  return `${formatMilliseconds(milliseconds).padStart(8)} / ${formatMilliseconds(totalMs).padStart(8)} (${percent.toFixed(1).padStart(5)}%)`;
}

function truncateLabel(label: string, width: number): string {
  if (label.length <= width) return label;
  return `${label.slice(0, Math.max(0, width - 1))}…`;
}

export function renderBenchmarkReport(results: DirectoryBenchmark[]): string {
  const lines = [
    "Pi startup benchmark",
    `${results[0]?.runs ?? DEFAULT_RUNS}-run median · offline`,
    "",
  ];

  for (const [index, result] of results.entries()) {
    lines.push(`${result.label} (${displayPath(result.cwd)})`);
    lines.push(
      `  ${"Full startup".padEnd(32)} ${formatMilliseconds(result.fullMs).padStart(8)}`,
    );
    lines.push(
      `  ${"No extensions".padEnd(32)} ${formatRatio(result.noExtensionsMs, result.fullMs)}`,
    );
    if (result.welcomeImportMs !== undefined) {
      lines.push(
        `  ${"Welcome import".padEnd(32)} ${formatRatio(result.welcomeImportMs, result.fullMs)}`,
      );
    }
    lines.push("");
    lines.push("  Extensions — isolated overhead / full startup");

    for (const extension of result.extensions) {
      const name = truncateLabel(extension.name, 30).padEnd(32);
      if (extension.error) {
        lines.push(`  ${name} unavailable`);
        continue;
      }
      lines.push(
        `  ${name} ${formatRatio(extension.overheadMs, result.fullMs)}  [isolated ${formatMilliseconds(extension.isolatedTotalMs)}]`,
      );
    }

    if (index < results.length - 1) lines.push("");
  }

  lines.push("");
  lines.push(
    "Isolated overhead = extension-only startup − no-extension startup.",
  );
  lines.push(
    "Values do not add to 100%; shared initialization can overlap. Negative deltas are shown as 0ms.",
  );
  return lines.join("\n");
}

function parseArguments(args: string[]): CliOptions {
  const options: CliOptions = {
    runs: DEFAULT_RUNS,
    scope: "both",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log(
        `Usage: bun run benchmarks/startup-benchmark.ts [options]\n\nOptions:\n  --runs <count>              Number of runs per measurement (default: 3)\n  --scope <both|current|home> Directories to profile (default: both)\n  --timeout-ms <milliseconds> Per-run timeout (default: 30000)\n  --help                      Show this help`,
      );
      process.exit(0);
    }

    const value = args[index + 1];
    if (argument === "--runs") {
      options.runs = Number(value);
      index++;
    } else if (argument === "--scope") {
      if (value !== "both" && value !== "current" && value !== "home") {
        throw new Error(`Invalid --scope: ${value ?? "missing"}`);
      }
      options.scope = value;
      index++;
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(value);
      index++;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  return options;
}

async function runPiStartup(options: RunOptions): Promise<StartupTiming> {
  const child = Bun.spawn(["expect", "-c", EXPECT_SCRIPT], {
    cwd: options.cwd,
    env: {
      ...process.env,
      PI_BENCH_TIMEOUT_SECONDS: String(Math.ceil(options.timeoutMs / 1_000)),
      PI_BENCH_NO_EXTENSIONS: options.noExtensions ? "1" : "0",
      PI_BENCH_EXTENSION: options.extensionPath ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Pi startup exceeded ${options.timeoutMs}ms`));
    }, options.timeoutMs + 1_000);
  });

  try {
    const exitCode = await Promise.race([child.exited, timedOut]);
    const output = await stdout;
    const errorOutput = stripAnsi(await stderr).trim();
    if (exitCode !== 0) {
      throw new Error(errorOutput || `Pi exited with status ${exitCode}`);
    }
    return parseStartupTiming(output);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function collectRuns(
  count: number,
  run: () => Promise<StartupTiming>,
): Promise<StartupTiming[]> {
  const results: StartupTiming[] = [];
  for (let index = 0; index < count; index++) results.push(await run());
  return results;
}

function medianImport(timings: StartupTiming[], path: string): number {
  const values = timings
    .map((timing) => timing.extensions.get(path)?.importMs)
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? median(values) : 0;
}

async function benchmarkDirectory(
  cwd: string,
  label: string,
  options: CliOptions,
): Promise<DirectoryBenchmark> {
  console.error(`\nBenchmarking ${label} (${displayPath(cwd)})`);
  console.error(`  full startup × ${options.runs}`);
  const fullRuns = await collectRuns(options.runs, () =>
    runPiStartup({ cwd, timeoutMs: options.timeoutMs }),
  );
  const fullMs = median(fullRuns.map((run) => run.totalMs));
  const extensionPaths = [
    ...new Set(fullRuns.flatMap((run) => [...run.extensions.keys()])),
  ].sort((left, right) =>
    extensionName(left).localeCompare(extensionName(right)),
  );

  console.error(`  no extensions × ${options.runs}`);
  const noExtensionRuns = await collectRuns(options.runs, () =>
    runPiStartup({
      cwd,
      timeoutMs: options.timeoutMs,
      noExtensions: true,
    }),
  );
  const noExtensionsMs = median(noExtensionRuns.map((run) => run.totalMs));
  const extensions: ExtensionBenchmark[] = [];

  for (const [index, path] of extensionPaths.entries()) {
    const name = extensionName(path);
    console.error(
      `  extension ${index + 1}/${extensionPaths.length}: ${name} × ${options.runs}`,
    );
    try {
      const isolatedRuns = await collectRuns(options.runs, () =>
        runPiStartup({
          cwd,
          timeoutMs: options.timeoutMs,
          noExtensions: true,
          extensionPath: path,
        }),
      );
      const isolatedTotalMs = median(isolatedRuns.map((run) => run.totalMs));
      extensions.push({
        name,
        path,
        importMs: medianImport(fullRuns, path),
        isolatedTotalMs,
        overheadMs: Math.max(0, isolatedTotalMs - noExtensionsMs),
      });
    } catch (error) {
      extensions.push({
        name,
        path,
        importMs: medianImport(fullRuns, path),
        isolatedTotalMs: 0,
        overheadMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  extensions.sort(
    (left, right) =>
      right.overheadMs - left.overheadMs || left.name.localeCompare(right.name),
  );
  const welcomePath = extensionPaths.find(isWelcomeScreenPath);

  return {
    label,
    cwd,
    runs: options.runs,
    fullMs,
    noExtensionsMs,
    welcomeImportMs: welcomePath
      ? medianImport(fullRuns, welcomePath)
      : undefined,
    extensions,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const currentDirectory = resolve(process.cwd());
  const homeDirectory = resolve(homedir());
  const directories: Array<{ cwd: string; label: string }> = [];

  if (options.scope === "current" || options.scope === "both") {
    directories.push({
      cwd: currentDirectory,
      label: currentDirectory === homeDirectory ? "Home" : "Current",
    });
  }
  if (
    (options.scope === "home" || options.scope === "both") &&
    currentDirectory !== homeDirectory
  ) {
    directories.push({ cwd: homeDirectory, label: "Home" });
  }
  if (directories.length === 0)
    directories.push({ cwd: homeDirectory, label: "Home" });

  const results: DirectoryBenchmark[] = [];
  for (const directory of directories) {
    results.push(
      await benchmarkDirectory(directory.cwd, directory.label, options),
    );
  }
  console.log(`\n${renderBenchmarkReport(results)}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `benchmark failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
