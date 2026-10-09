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
  "src/_bounded-runner.ts",
  "src/_child-events.ts",
  "src/_concurrency.ts",
  "src/_definition.ts",
  "src/_delegation.ts",
  "src/_display.ts",
  "src/_execution.ts",
  "src/_limits.ts",
  "src/_managed-child.ts",
  "src/_managed-delivery-policy.ts",
  "src/_managed-delivery.ts",
  "src/_managed-format.ts",
  "src/_managed-host-herdr.ts",
  "src/_managed-host-rpc.ts",
  "src/_managed-host.ts",
  "src/_managed-ledger.ts",
  "src/_managed-notifications.ts",
  "src/_managed-policy.ts",
  "src/_managed-protocol.ts",
  "src/_managed-store.ts",
  "src/_managed-tool.ts",
  "src/_managed-ui.ts",
  "src/_managed.ts",
  "src/_parse.ts",
  "src/_process-tree.ts",
  "src/_profile-attempts.ts",
  "src/_profiles.ts",
  "src/_render.ts",
  "src/_session-resources.ts",
  "src/_subagent-command.ts",
  "src/_text.ts",
  "src/_transcript.ts",
  "src/_usage.ts",
  "src/_yield.ts",
  "src/index.ts",
  "src/limits.json",
  "src/subagent.ts",
].sort();

if (JSON.stringify(files) !== JSON.stringify(expected)) {
  console.error("Unexpected npm package contents:");
  console.error(files.join("\n"));
  process.exit(1);
}

console.log(
  `Verified ${pack.filename}: ${files.length} reviewed files, ${pack.size} bytes packed.`,
);
