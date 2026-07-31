import { execFileSync } from "node:child_process";

const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  },
);
const [pack] = JSON.parse(output);
const files = pack.files.map(({ path }) => path).sort();
const expected = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "index.ts",
  "package.json",
  "settings.json",
  "src/compact-client.ts",
  "src/compaction-output.ts",
  "src/details-store.ts",
  "src/extension-runtime.ts",
  "src/payload-rewrite.ts",
  "src/portable-summary.ts",
  "src/runtime.ts",
  "src/serializer.ts",
  "src/settings.ts",
  "src/types.ts",
].sort();

if (JSON.stringify(files) !== JSON.stringify(expected)) {
  console.error("Unexpected npm package contents:");
  console.error(files.join("\n"));
  process.exit(1);
}

console.log(
  `Verified ${pack.filename}: ${files.length} reviewed files, ${pack.size} bytes packed.`,
);
