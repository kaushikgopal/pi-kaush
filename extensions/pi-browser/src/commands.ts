/**
 * Slash commands: /browser-status and /browser-profile.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { request } from "./core/client.ts";
import { discoverEndpoint } from "./core/discovery.ts";
import { listProfiles, type ProfilePin } from "./core/profile.ts";

const CLEAR_ROW = "— Clear pin (use whichever profile is focused) —";

interface StatusResult {
  connected: boolean;
  userDataDir: string | null;
  ownedTabs: number;
  pin: ProfilePin | null;
  daemonPid: number;
}

export function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand("browser-status", {
    description:
      "Show pi-browser daemon state, profile pin, and owned tab count",
    handler: async (_args, ctx) => {
      let info: StatusResult;
      try {
        info = await request<StatusResult>("status");
      } catch (error) {
        ctx.ui.notify(
          `daemon unavailable: ${(error as Error).message}`,
          "error",
        );
        return;
      }
      ctx.ui.notify(
        [
          `daemon: pid ${info.daemonPid}, browser ${info.connected ? "connected" : "not yet connected (lazy)"}`,
          `browser: ${info.userDataDir ?? "—"}`,
          `profile pin: ${info.pin ? `${info.pin.label} (${info.pin.profileDirectory})` : "none — tabs open in the focused profile"}`,
          `owned tabs: ${info.ownedTabs}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("browser-profile", {
    description: "Choose which browser profile pi-browser works in (persisted)",
    handler: async (_args, ctx) => {
      let endpoint;
      try {
        endpoint = await discoverEndpoint();
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        return;
      }
      const profiles = listProfiles(endpoint.userDataDir);
      if (profiles.length === 0) {
        ctx.ui.notify(`no profiles found in ${endpoint.userDataDir}`, "error");
        return;
      }

      const seen = new Map<string, number>();
      for (const p of profiles)
        seen.set(p.name + p.email, (seen.get(p.name + p.email) ?? 0) + 1);
      const labelOf = (p: (typeof profiles)[number]): string => {
        const base = `${p.name}${p.email ? ` (${p.email})` : ""}`;
        return (seen.get(p.name + p.email) ?? 0) > 1
          ? `${base} [${p.directory}]`
          : base;
      };

      let current: ProfilePin | null = null;
      try {
        current = await request<ProfilePin | null>("getPin");
      } catch {
        // daemon unavailable; show unmarked picker
      }
      const rows = [
        ...profiles.map((p) => {
          const label = labelOf(p);
          return current?.profileDirectory === p.directory
            ? `✓ ${label}`
            : label;
        }),
        CLEAR_ROW,
      ];
      const picked = await ctx.ui.select(
        "Select the browser profile pi-browser should use",
        rows,
      );
      if (!picked) return;

      const index = rows.indexOf(picked);
      const profile = profiles[index];
      if (!profile) {
        await request("setPin", { pin: null });
        ctx.ui.notify(
          "profile pin cleared — tabs open in whichever profile window is focused",
          "info",
        );
        return;
      }
      const pin: ProfilePin = {
        profileDirectory: profile.directory,
        label: profile.name,
        userDataDir: endpoint.userDataDir,
      };
      await request("setPin", { pin });
      ctx.ui.notify(
        `pi-browser pinned to profile: ${profile.name}. Any owned tabs were closed; the next browser tool seeds a window in this profile.`,
        "info",
      );
    },
  });
}
