/**
 * Profile pinning: choose which browser profile pi-browser works in.
 *
 * Chromium offers no CDP route to create tabs in a non-default profile's
 * browser context (Target.createTarget rejects another profile's context).
 * The working route: ask the browser's own command line to open a window in
 * the pinned profile (ProcessSingleton delegates to the running instance),
 * find it by a unique file:// sentinel page, then open further tabs with
 * window.open from pages in that window — the only CDP-reachable way to stay
 * in the pinned context. Approach credited to pi-browser-harness (MIT).
 */

import { readFileSync, existsSync } from "node:fs";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ProfileInfo {
  directory: string;
  name: string;
  email: string;
}

export interface ProfilePin {
  profileDirectory: string;
  label: string;
  userDataDir: string;
}

/** Profiles from Chromium's `Local State` file in a user-data dir. */
export const listProfiles = (userDataDir: string): ProfileInfo[] => {
  try {
    const raw = JSON.parse(
      readFileSync(join(userDataDir, "Local State"), "utf8"),
    ) as {
      profile?: {
        info_cache?: Record<string, { name?: string; user_name?: string }>;
      };
    };
    return Object.entries(raw.profile?.info_cache ?? {}).map(
      ([directory, info]) => ({
        directory,
        name: info.name ?? directory,
        email: info.user_name ?? "",
      }),
    );
  } catch {
    return [];
  }
};

const agentDir = (): string => {
  const fromEnv = process.env["PI_CODING_AGENT_DIR"];
  if (fromEnv) return fromEnv;
  return join(homedir(), ".pi", "agent");
};

const pinFilePath = (): string => join(agentDir(), "pi-browser.json");

export const loadPin = (): ProfilePin | null => {
  try {
    const raw = JSON.parse(
      readFileSync(pinFilePath(), "utf8"),
    ) as Partial<ProfilePin>;
    if (raw.profileDirectory && raw.userDataDir) {
      return {
        profileDirectory: raw.profileDirectory,
        label: raw.label ?? raw.profileDirectory,
        userDataDir: raw.userDataDir,
      };
    }
  } catch {
    // no pin yet
  }
  return null;
};

export const savePin = async (pin: ProfilePin): Promise<void> => {
  await mkdir(dirname(pinFilePath()), { recursive: true });
  await writeFile(pinFilePath(), JSON.stringify(pin, null, 2) + "\n", {
    mode: 0o600,
  });
};

export const clearPin = async (): Promise<void> => {
  await rm(pinFilePath(), { force: true });
};

/** Map a discovered user-data dir back to its browser executable. */
export const executableFor = (userDataDir: string): string | null => {
  const darwin: Array<[string, string]> = [
    ["net.imput.helium", "/Applications/Helium.app/Contents/MacOS/Helium"],
    [
      "Google/Chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ],
    ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    [
      "BraveSoftware/Brave-Browser",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ],
    [
      "Microsoft Edge",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
  ];
  const linux: Array<[string, string]> = [
    ["helium", "helium"],
    ["google-chrome", "google-chrome"],
    ["chromium", "chromium"],
    ["BraveSoftware/Brave-Browser", "brave-browser"],
    ["microsoft-edge", "microsoft-edge"],
  ];
  const table = process.platform === "darwin" ? darwin : linux;
  for (const [marker, executable] of table) {
    if (userDataDir.includes(marker)) {
      if (process.platform === "darwin")
        return existsSync(executable) ? executable : null;
      return executable; // resolved from PATH on linux
    }
  }
  return null;
};
