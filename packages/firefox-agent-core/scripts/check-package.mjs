import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
execFileSync("npm", ["run", "build"], {
  cwd: packageDirectory,
  stdio: "inherit",
});

const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: packageDirectory,
    encoding: "utf8",
  },
);
const [pack] = JSON.parse(output);
const files = pack.files.map(({ path }) => path).sort();
const expected = [
  "LICENSE",
  "README.md",
  "SUPPORTED_FIREFOX_CLI.md",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/automation.d.ts",
  "dist/automation.js",
  "dist/persistent.d.ts",
  "dist/persistent.js",
  "dist/tool-catalog.d.ts",
  "dist/tool-catalog.js",
  "dist/activity.d.ts",
  "dist/activity.js",
  "dist/browser-api.d.ts",
  "dist/browser-api.js",
  "dist/browser-cli.d.ts",
  "dist/browser-cli.js",
  "dist/browser-types.d.ts",
  "dist/browser-types.js",
  "dist/browser-identity.d.ts",
  "dist/browser-identity.js",
  "dist/config.d.ts",
  "dist/config.js",
  "dist/diagnostics.d.ts",
  "dist/diagnostics.js",
  "dist/extraction.d.ts",
  "dist/extraction.js",
  "dist/state-store.d.ts",
  "dist/state-store.js",
  "dist/workflows.d.ts",
  "dist/workflows.js",
  "dist/browser-feature-types.d.ts",
  "dist/browser-feature-types.js",
  "dist/browser-features.d.ts",
  "dist/browser-features.js",
  "dist/browser-snapshot-data.d.ts",
  "dist/browser-snapshot-data.js",
  "dist/summary.d.ts",
  "dist/summary.js",
  "dist/sessions.d.ts",
  "dist/sessions.js",
  "dist/parsers.d.ts",
  "dist/parsers.js",
  "dist/transport.d.ts",
  "dist/transport.js",
  "dist/types.d.ts",
  "dist/types.js",
  "package.json",
].sort();

if (JSON.stringify(files) !== JSON.stringify(expected)) {
  console.error("Unexpected npm package contents:");
  console.error(files.join("\n"));
  process.exit(1);
}

console.log(
  `Verified ${pack.filename}: ${files.length} reviewed files, ${pack.size} bytes packed.`,
);
