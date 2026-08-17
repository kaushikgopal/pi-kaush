/**
 * Slash commands: /browser-status and /browser-profile.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectionInfo, setPin } from "./core/connection.ts";
import { discoverEndpoint } from "./core/discovery.ts";
import { listProfiles, type ProfilePin } from "./core/profile.ts";

const CLEAR_ROW = "— Clear pin (use whichever profile is focused) —";

export function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand("browser-status", {
    description:
      "Show pi-browser connection state, profile pin, and owned tab count",
    handler: async (_args, ctx) => {
      const info = connectionInfo();
      ctx.ui.notify(
        [
          `connected: ${info.connected ? "yes" : "not yet (connects lazily on first browser tool use)"}`,
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

      // Disambiguate duplicate display names with the directory.
      const seen = new Map<string, number>();
      for (const p of profiles)
        seen.set(p.name + p.email, (seen.get(p.name + p.email) ?? 0) + 1);
      const labelOf = (p: (typeof profiles)[number]): string => {
        const base = `${p.name}${p.email ? ` (${p.email})` : ""}`;
        return (seen.get(p.name + p.email) ?? 0) > 1
          ? `${base} [${p.directory}]`
          : base;
      };

      const current = connectionInfo().pin;
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
        await setPin(null);
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
      await setPin(pin);
      ctx.ui.notify(
        `pi-browser pinned to profile: ${profile.name}. Any owned tabs were closed; the next browser tool seeds a window in this profile.`,
        "info",
      );
    },
  });
}
