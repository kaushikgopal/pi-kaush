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
