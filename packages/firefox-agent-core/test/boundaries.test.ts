import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

async function importsIn(
  directory: string,
): Promise<Array<{ file: string; specifier: string }>> {
  const imports: Array<{ file: string; specifier: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      imports.push(...(await importsIn(file)));
    } else if (entry.name.endsWith(".ts")) {
      const source = ts.createSourceFile(
        file,
        await readFile(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (
          (ts.isImportDeclaration(statement) ||
            ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          imports.push({ file, specifier: statement.moduleSpecifier.text });
        }
      }
    }
  }
  return imports;
}

test("core production modules import only Node or local core modules", async () => {
  const directory = fileURLToPath(new URL("../src/", import.meta.url));
  for (const { file, specifier } of await importsIn(directory)) {
    expect(
      specifier.startsWith("node:") || specifier.startsWith("."),
      `${file}: ${specifier}`,
    ).toBe(true);
    if (specifier.startsWith(".")) {
      expect(
        resolve(dirname(file), specifier).startsWith(directory),
        `${file}: ${specifier}`,
      ).toBe(true);
    }
  }
});

test("the Pi adapter imports core only through its public package entry", async () => {
  const directory = fileURLToPath(
    new URL("../../../extensions/pi-firefox/src/", import.meta.url),
  );
  for (const { file, specifier } of await importsIn(directory)) {
    if (specifier.includes("firefox-agent-core")) {
      expect(specifier, `${file}: ${specifier}`).toBe(
        "@pi-kaush/firefox-agent-core",
      );
    }
  }
});

test("core remains a library workspace outside the Pi extensions", async () => {
  const [workspace, core, adapter] = await Promise.all(
    [
      "../../../package.json",
      "../package.json",
      "../../../extensions/pi-firefox/package.json",
    ].map(async (path) =>
      JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
    ),
  );
  expect(workspace.workspaces).toContain("packages/*");
  expect(core.name).toBe("@pi-kaush/firefox-agent-core");
  expect(core.pi).toBeUndefined();
  expect(Object.keys(core.dependencies ?? {})).toEqual([]);
  expect(adapter.name).toBe("@pi-kaush/pi-firefox");
  expect(adapter.dependencies[core.name]).toBe(`^${core.version}`);
  expect(adapter.dependencies["@pi-kaush/firefox-core"]).toBeUndefined();
});
