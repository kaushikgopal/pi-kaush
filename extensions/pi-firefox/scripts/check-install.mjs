import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const extensionDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryDirectory = resolve(extensionDirectory, "../..");
const coreDirectory = join(repositoryDirectory, "packages/firefox-agent-core");
const realRepositoryDirectory = await realpath(repositoryDirectory);
const extensionManifest = JSON.parse(
  await readFile(join(extensionDirectory, "package.json"), "utf8"),
);
const coreManifest = JSON.parse(
  await readFile(join(coreDirectory, "package.json"), "utf8"),
);

for (const file of ["dist/index.js", "dist/index.d.ts"]) {
  const filePath = join(coreDirectory, file);
  assert.ok((await stat(filePath)).isFile(), `Core build is missing ${file}.`);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-firefox-install-"));

try {
  const tarballDirectory = join(temporaryDirectory, "tarballs");
  const projectDirectory = join(temporaryDirectory, "project");
  const userConfigPath = join(temporaryDirectory, "npmrc");
  const globalConfigPath = join(temporaryDirectory, "global-npmrc");
  await Promise.all([
    mkdir(tarballDirectory),
    mkdir(projectDirectory),
    writeFile(userConfigPath, "", { mode: 0o600 }),
    writeFile(globalConfigPath, "", { mode: 0o600 }),
  ]);

  const npmEnvironment = {
    ...process.env,
    npm_config_cache: join(temporaryDirectory, "npm-cache"),
    npm_config_global: "false",
    npm_config_globalconfig: globalConfigPath,
    npm_config_userconfig: userConfigPath,
  };
  const pack = (directory, manifest) => {
    const output = runNpm(
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        tarballDirectory,
      ],
      directory,
      npmEnvironment,
    );
    const [metadata] = JSON.parse(output);
    assert.equal(metadata.name, manifest.name);
    assert.equal(metadata.version, manifest.version);
    return join(tarballDirectory, metadata.filename);
  };

  const coreTarball = pack(coreDirectory, coreManifest);
  const extensionTarball = pack(extensionDirectory, extensionManifest);
  await writeFile(
    join(projectDirectory, "package.json"),
    JSON.stringify({ private: true, name: "pi-firefox-install-smoke" }),
  );
  runNpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=peer",
      coreTarball,
      extensionTarball,
    ],
    projectDirectory,
    npmEnvironment,
  );

  const installedExtensionDirectory = join(
    projectDirectory,
    "node_modules/@pi-kaush/pi-firefox",
  );
  const installedCoreDirectory = join(
    projectDirectory,
    "node_modules/@pi-kaush/firefox-agent-core",
  );
  const realProjectDirectory = await realpath(projectDirectory);
  for (const directory of [
    installedExtensionDirectory,
    installedCoreDirectory,
  ]) {
    assert.ok(!(await lstat(directory)).isSymbolicLink());
    const installedPath = await realpath(directory);
    assert.ok(
      installedPath.startsWith(`${realProjectDirectory}${sep}`),
      `Installed package is outside the isolated project: ${installedPath}`,
    );
    assert.ok(
      !installedPath.startsWith(`${realRepositoryDirectory}${sep}`),
      `Installed package resolves into the workspace: ${installedPath}`,
    );
  }

  const installedExtensionManifestPath = join(
    installedExtensionDirectory,
    "package.json",
  );
  const installedCoreManifestPath = join(
    installedCoreDirectory,
    "package.json",
  );
  const installedExtensionManifest = JSON.parse(
    await readFile(installedExtensionManifestPath, "utf8"),
  );
  const installedCoreManifest = JSON.parse(
    await readFile(installedCoreManifestPath, "utf8"),
  );
  assert.equal(installedExtensionManifest.name, extensionManifest.name);
  assert.equal(installedCoreManifest.name, coreManifest.name);
  assert.ok(installedExtensionManifest.dependencies?.[coreManifest.name]);
  const coreTree = JSON.parse(
    runNpm(
      ["ls", coreManifest.name, "--all", "--json", "--omit=peer"],
      projectDirectory,
      npmEnvironment,
    ),
  );
  const extensionTree = JSON.parse(
    runNpm(
      ["ls", extensionManifest.name, "--all", "--json", "--omit=peer"],
      projectDirectory,
      npmEnvironment,
    ),
  );
  assert.equal(
    coreTree.dependencies?.[coreManifest.name]?.version,
    installedCoreManifest.version,
    "npm must resolve the installed root core tarball version.",
  );
  assert.equal(
    extensionTree.dependencies?.[extensionManifest.name]?.version,
    installedExtensionManifest.version,
    "npm must resolve the installed Pi tarball version.",
  );

  assert.ok(installedExtensionManifest.types);
  assert.equal(
    installedExtensionManifest.exports,
    installedExtensionManifest.types,
  );
  assert.ok(
    (
      await stat(
        join(installedExtensionDirectory, installedExtensionManifest.types),
      )
    ).isFile(),
  );
  assert.deepEqual(Object.keys(installedCoreManifest.exports), ["."]);
  const coreExportTargets = Object.values(installedCoreManifest.exports["."]);
  assert.ok(coreExportTargets.includes(installedCoreManifest.types));
  assert.ok(coreExportTargets.every((target) => target.startsWith("./")));
  for (const target of coreExportTargets) {
    assert.ok((await stat(join(installedCoreDirectory, target))).isFile());
  }
  assert.equal(installedCoreManifest.pi, undefined);
  assert.deepEqual(installedCoreManifest.dependencies ?? {}, {});

  const publicCoreImport = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
import { createFirefoxClient, FIREFOX_TOOLS } from "${coreManifest.name}";
assert.equal(typeof createFirefoxClient, "function");
assert.equal(FIREFOX_TOOLS.length, 16);
process.stdout.write(import.meta.resolve("${coreManifest.name}"));`,
    ],
    { cwd: projectDirectory, encoding: "utf8", timeout: 60_000 },
  );
  const resolvedCoreEntry = fileURLToPath(publicCoreImport);
  assert.equal(
    await realpath(resolvedCoreEntry),
    await realpath(join(installedCoreDirectory, "dist/index.js")),
    "Pi must resolve its installed core dependency, not workspace output.",
  );

  const dependencyProbePath = join(
    installedExtensionDirectory,
    "check-install-probe.mjs",
  );
  await writeFile(
    dependencyProbePath,
    `process.stdout.write(JSON.stringify({
  parent: import.meta.url,
  core: import.meta.resolve("${coreManifest.name}"),
}));
`,
  );
  const dependencyProbe = JSON.parse(
    execFileSync(process.execPath, [dependencyProbePath], {
      cwd: projectDirectory,
      encoding: "utf8",
      timeout: 60_000,
    }),
  );
  assert.equal(
    dependencyProbe.parent,
    pathToFileURL(await realpath(dependencyProbePath)).href,
    "Dependency probe must run from the installed Pi package directory.",
  );
  assert.equal(
    dirname(fileURLToPath(dependencyProbe.parent)),
    await realpath(installedExtensionDirectory),
  );
  assert.equal(
    await realpath(fileURLToPath(dependencyProbe.core)),
    await realpath(join(installedCoreDirectory, "dist/index.js")),
    "Installed Pi must resolve its own core dependency, not workspace output.",
  );

  const skillPaths = installedExtensionManifest.pi?.skills;
  assert.ok(Array.isArray(skillPaths) && skillPaths.length > 0);
  for (const skillPath of skillPaths) {
    const skillFile = join(installedExtensionDirectory, skillPath, "SKILL.md");
    assert.ok(
      (await stat(skillFile)).isFile(),
      `Missing packaged skill: ${skillPath}`,
    );
  }

  const { FIREFOX_TOOLS } = await import(pathToFileURL(resolvedCoreEntry).href);
  const loaded = await discoverAndLoadExtensions(
    [installedExtensionDirectory],
    projectDirectory,
    projectDirectory,
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const [extension] = loaded.extensions;
  const toolNames = [...extension.tools.keys()].sort();
  const commandNames = [...extension.commands.keys()].sort();
  assert.equal(toolNames.length, 16);
  assert.deepEqual(toolNames, FIREFOX_TOOLS.map(({ name }) => name).sort());
  assert.deepEqual(commandNames, [
    "firefox-container",
    "firefox-session",
    "firefox-status",
  ]);

  console.log(
    `Verified installed core and Pi tarballs: ${toolNames.length} tools, ${commandNames.length} commands, ${skillPaths.length} skill path(s).`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function runNpm(args, cwd, env) {
  try {
    return execFileSync("npm", args, {
      cwd,
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    });
  } catch (error) {
    const detail = [error.stderr, error.stdout]
      .map((value) => value?.toString().trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `npm ${args[0]} failed${detail ? `:\n${detail.slice(-4000)}` : `: ${error.message}`}`,
    );
  }
}
