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
  "package.json",
  "src/edit/input.ts",
  "src/edit/tool.ts",
  "src/hashline/apply.ts",
  "src/hashline/contract.ts",
  "src/hashline/recovery.ts",
  "src/hashline/parser.ts",
  "src/hashline/registry.ts",
  "src/hashline/render.ts",
  "src/hashline/snapshot-store.ts",
  "src/index.ts",
  "src/model-routing.ts",
  "src/read/artifacts.ts",
  "src/read/bounded.ts",
  "src/read/commands.ts",
  "src/read/local-text.ts",
  "src/read/safe-url.ts",
  "src/read/selectors.ts",
  "src/settings.ts",
  "src/read/tool.ts",
].sort();

if (JSON.stringify(files) !== JSON.stringify(expected)) {
  console.error("Unexpected npm package contents:");
  console.error(files.join("\n"));
  process.exit(1);
}

console.log(
  `Verified ${pack.filename}: ${files.length} reviewed files, ${pack.size} bytes packed.`,
);
