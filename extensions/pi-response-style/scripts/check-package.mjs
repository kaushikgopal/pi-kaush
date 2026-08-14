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

// Assert shape, not exact contents: sources and style templates grow over time.
const required = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
  "src/index.ts",
];
const allowed =
  /^(CHANGELOG\.md|LICENSE|README\.md|package\.json|src\/.+\.ts|styles\/.+\.md)$/;
const styles = files.filter((path) => path.startsWith("styles/"));

const missing = required.filter((path) => !files.includes(path));
const unexpected = files.filter((path) => !allowed.test(path));

if (missing.length > 0 || unexpected.length > 0 || styles.length < 1) {
  if (missing.length > 0) console.error(`Missing: ${missing.join(", ")}`);
  if (unexpected.length > 0)
    console.error(`Unexpected: ${unexpected.join(", ")}`);
  if (styles.length < 1)
    console.error("Missing: at least one styles/*.md template");
  console.error(files.join("\n"));
  process.exit(1);
}

console.log(
  `Verified ${pack.filename}: ${files.length} reviewed files, ${pack.size} bytes packed.`,
);
