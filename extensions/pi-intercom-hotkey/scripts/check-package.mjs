import { execFileSync } from "node:child_process";
import { deepStrictEqual } from "node:assert/strict";

const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  }),
);

deepStrictEqual(pack.files.map(({ path }) => path).sort(), [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
  "src/index.ts",
]);
console.log(`Verified ${pack.filename}: ${pack.size} bytes packed.`);
