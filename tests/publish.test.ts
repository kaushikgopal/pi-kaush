import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, test } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const program = `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
const command=path.basename(process.argv[1]);const args=process.argv.slice(2);
fs.appendFileSync(process.env.EVENT_LOG,JSON.stringify({command,args})+'\\n');
if(command==='git' && args[0]==='status' && process.env.TEST_DIRTY==='true')process.stdout.write(' M unrelated.txt\\n');
if(command==='npm' && args[0]==='view'){
 if(process.env.TEST_CORE_PUBLISHED!=='true'){process.stderr.write('core is not published');process.exit(1);}
 console.log(JSON.stringify('0.1.0'));
}
if(command==='jq'){
 const value=JSON.parse(fs.readFileSync(args.at(-1),'utf8'));
 if(args[0]==='--arg'){value.version=args[2];console.log(JSON.stringify(value,null,2));}
 else if(args[1]==='.name')console.log(value.name);
 else if(args[1]==='.version')console.log(value.version);
 else console.log(value.dependencies['@pi-kaush/firefox-agent-core']);
}
`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-publish-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const command of ["git", "gh", "npm", "jq"])
    await writeFile(join(bin, command), program, { mode: 0o700 });
  for (const [directory, name, version] of [
    ["packages/firefox-agent-core", "firefox-agent-core", "0.1.0"],
    ["extensions/pi-firefox", "pi-firefox", "0.1.0"],
    ["extensions/pi-btw", "pi-btw", "0.1.0"],
  ]) {
    await mkdir(join(root, directory!), { recursive: true });
    await writeFile(
      join(root, directory!, "package.json"),
      JSON.stringify({
        name: `@pi-kaush/${name}`,
        version,
        ...(name === "pi-firefox"
          ? { dependencies: { "@pi-kaush/firefox-agent-core": "^0.1.0" } }
          : {}),
      }),
    );
  }
  const log = join(root, "events.jsonl");
  await writeFile(log, "");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    EVENT_LOG: log,
  };
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { command: string; args: string[] });
  return { root, env, calls };
}
const script = resolve("scripts/publish.sh");

describe("release script", () => {
  test.each([
    ["firefox-agent-core", "packages/firefox-agent-core"],
    ["pi-firefox", "extensions/pi-firefox"],
    ["pi-btw", "extensions/pi-btw"],
  ])(
    "resolves %s without changing the existing extension path",
    async (name, directory) => {
      const f = await fixture();
      execFileSync("bash", [script, name], {
        cwd: f.root,
        env: { ...f.env, TEST_CORE_PUBLISHED: "true" },
        stdio: "pipe",
      });
      expect(
        JSON.parse(
          await readFile(join(f.root, directory, "package.json"), "utf8"),
        ).version,
      ).toBe("0.1.1");
      const calls = await f.calls();
      expect(calls).toContainEqual({
        command: "git",
        args: ["add", `${directory}/package.json`],
      });
      expect(
        calls.find(
          (call) => call.command === "gh" && call.args[0] === "release",
        )?.args,
      ).toContain(`${name}-v0.1.1`);
      const views = calls.filter(
        (call) => call.command === "npm" && call.args[0] === "view",
      );
      expect(views).toEqual(
        name === "pi-firefox"
          ? [
              {
                command: "npm",
                args: [
                  "view",
                  "@pi-kaush/firefox-agent-core@^0.1.0",
                  "version",
                  "--json",
                ],
              },
            ]
          : [],
      );
    },
    15000,
  );
  test("blocks adapter release before any version change when core is unpublished", async () => {
    const f = await fixture();
    expect(() =>
      execFileSync("bash", [script, "pi-firefox"], {
        cwd: f.root,
        env: f.env,
        stdio: "pipe",
      }),
    ).toThrow();
    expect(
      JSON.parse(
        await readFile(
          join(f.root, "extensions/pi-firefox/package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("0.1.0");
    const calls = await f.calls();
    expect(
      calls.some(
        (call) =>
          call.command === "git" &&
          ["add", "commit", "push"].includes(call.args[0]!),
      ),
    ).toBe(false);
    expect(
      calls.some((call) => call.command === "gh" && call.args[0] === "release"),
    ).toBe(false);
    expect(
      calls.some((call) => call.command === "npm" && call.args[0] === "run"),
    ).toBe(false);
  });
  test("rejects a dirty tree before registry access or release effects", async () => {
    const f = await fixture();
    expect(() =>
      execFileSync("bash", [script, "pi-firefox"], {
        cwd: f.root,
        env: { ...f.env, TEST_DIRTY: "true" },
        stdio: "pipe",
      }),
    ).toThrow();
    expect(
      (await f.calls()).every(
        (call) => call.command === "git" && call.args[0] === "status",
      ),
    ).toBe(true);
  });
});

const workflow = await readFile(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
function runStep(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  if (start < 0) throw new Error(`Missing workflow step: ${name}`);
  const run = lines.findIndex(
    (line, index) => index > start && line === "        run: |",
  );
  if (run < 0) throw new Error(`Missing workflow run block: ${name}`);
  const commands: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.startsWith("      - ")) break;
    if (line.trim()) commands.push(line.slice(10));
  }
  return commands.join("\n");
}
describe("release workflow", () => {
  test("limits the core publication prerequisite to the Firefox adapter", () => {
    const step = workflow.split(
      "      - name: Verify published Firefox core\n",
    )[1];
    const condition = /^        if: (.+)$/m.exec(step ?? "")?.[1];
    expect(condition).toBeDefined();
    for (const workspace of [
      "@pi-kaush/firefox-agent-core",
      "@pi-kaush/pi-firefox",
      "@pi-kaush/pi-btw",
    ]) {
      expect(
        vm.runInNewContext(condition!, {
          steps: { package: { outputs: { workspace } } },
        }),
      ).toBe(workspace === "@pi-kaush/pi-firefox");
    }
  });

  test("enables both Firefox release tags while retaining other packages", () => {
    const condition = /^    if: (.+)$/m.exec(workflow)?.[1];
    expect(condition).toBeDefined();
    for (const tag of [
      "firefox-agent-core-v0.1.0",
      "pi-firefox-v0.1.0",
      "pi-btw-v0.1.0",
      "unrelated-v0.1.0",
    ]) {
      const enabled = vm.runInNewContext(condition!, {
        github: { event: { release: { tag_name: tag } } },
        startsWith: (value: string, prefix: string) => value.startsWith(prefix),
      });
      expect(enabled).toBe(!tag.startsWith("unrelated"));
    }
  });
  test.each([
    ["firefox-agent-core", "@pi-kaush/firefox-agent-core"],
    ["pi-firefox", "@pi-kaush/pi-firefox"],
    ["pi-btw", "@pi-kaush/pi-btw"],
  ])(
    "resolves the %s tag and checks its package version",
    async (name, workspace) => {
      const f = await fixture();
      const output = join(f.root, "output");
      execFileSync("bash", ["-euc", runStep("Resolve release package")], {
        cwd: f.root,
        env: { ...f.env, RELEASE_TAG: `${name}-v0.1.0`, GITHUB_OUTPUT: output },
        stdio: "pipe",
      });
      expect(await readFile(output, "utf8")).toBe(`workspace=${workspace}\n`);
      expect(() =>
        execFileSync("bash", ["-euc", runStep("Resolve release package")], {
          cwd: f.root,
          env: {
            ...f.env,
            RELEASE_TAG: `${name}-v9.9.9`,
            GITHUB_OUTPUT: output,
          },
          stdio: "pipe",
        }),
      ).toThrow();
    },
  );
  test("checks the actual declared core range before publishing the adapter", async () => {
    const f = await fixture();
    const commands = runStep("Verify published Firefox core");
    expect(() =>
      execFileSync("bash", ["-euc", commands], {
        cwd: f.root,
        env: f.env,
        stdio: "pipe",
      }),
    ).toThrow();
    execFileSync("bash", ["-euc", commands], {
      cwd: f.root,
      env: { ...f.env, TEST_CORE_PUBLISHED: "true" },
      stdio: "pipe",
    });
    expect(await f.calls()).toEqual(
      Array.from({ length: 2 }, () => ({
        command: "npm",
        args: [
          "view",
          "@pi-kaush/firefox-agent-core@^0.1.0",
          "version",
          "--json",
        ],
      })),
    );
  });
});
