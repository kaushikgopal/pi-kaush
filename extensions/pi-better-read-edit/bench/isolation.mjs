// Per-arm isolation: private PI_CODING_AGENT_DIR + fresh workspace.
//
// Every arm runs in its own temp directory pair:
//   - workspace/  the fixture start tree; the model edits this (cwd).
//   - agent/      PI_CODING_AGENT_DIR, chmod 0700.
//
// The agent dir COPYs auth.json / models.json / models-store.json from the
// real agent dir (0600, existing files only) so provider auth and model
// definitions keep working. It also receives a forced settings.json whose
// betterReadEdit.avoidModels is empty, so an avoidlist from the user's
// global settings can never silently route the "better" arm onto the
// builtin tools.
//
// This is NOT an OS sandbox: the model and its tools run as the current
// user and can read/write anywhere the user can. The harness only provides
// a fresh working directory and an isolated PI_CODING_AGENT_DIR. Use the
// bench only with models you trust.

import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_CONFIG_FILES, FORCED_SETTINGS } from "./config.mjs";

/** Create a private workspace + agent dir pair under a run's tmp folder. */
export async function createIsolation({ tmpBaseDir, key, realAgentDir }) {
  await mkdir(tmpBaseDir, { recursive: true });
  const workspaceDir = await mkdtemp(join(tmpBaseDir, `${key}.ws-`));
  const agentDir = await mkdtemp(join(tmpBaseDir, `${key}.agent-`));
  await chmod(agentDir, 0o700);
  const copied = [];
  for (const name of AGENT_CONFIG_FILES) {
    const source = join(realAgentDir, name);
    if (!existsSync(source)) continue;
    const target = join(agentDir, name);
    await copyFile(source, target);
    await chmod(target, 0o600);
    copied.push(name);
  }
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(
    settingsPath,
    `${JSON.stringify(FORCED_SETTINGS, null, 2)}\n`,
  );
  await chmod(settingsPath, 0o600);
  return {
    workspaceDir,
    agentDir,
    copied,
    settingsForced: true,
    cleanup: () => cleanupPair(workspaceDir, agentDir),
  };
}

/** Remove both temp dirs. Safe to call more than once. */
async function cleanupPair(workspaceDir, agentDir) {
  await rm(workspaceDir, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
}
