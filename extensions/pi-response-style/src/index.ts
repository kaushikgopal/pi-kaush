/**
 * `/response-style` — switch how the Pi agent responds in chat.
 *
 * Pick a named response style from a picker; the style body is appended to
 * the system prompt each turn with a guardrail that keeps thinking traces,
 * tool calls, and code unstyled. Styles are markdown files: bundled styles
 * ship in the package, user styles in `<agentDir>/response-styles/` override
 * by filename. Selection resolves as: session pick > configured default >
 * last-used > off.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type CustomEntry,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { buildInjection, loadStyles, type Style } from "./styles.ts";
import { buildPickerItems, OFF_VALUE, showStylePicker } from "./picker.ts";
import {
  isSessionPick,
  readDefaultName,
  readLastUsed,
  resolveActive,
  writeDefaultName,
  writeLastUsed,
  type SessionPick,
} from "./state.ts";

const STATE_TYPE = "pi-response-style/state";
const STATUS_KEY = "response-style";

// Env overrides exist as a test seam; normal installs never set them.
const BUNDLED_STYLES_DIR =
  process.env.PI_RESPONSE_STYLE_BUNDLED_DIR ??
  fileURLToPath(new URL("../styles", import.meta.url));

export default function piResponseStyle(pi: ExtensionAPI) {
  const userStylesDir =
    process.env.PI_RESPONSE_STYLE_DIR ?? join(getAgentDir(), "response-styles");
  const stateFile =
    process.env.PI_RESPONSE_STYLE_STATE_FILE ??
    join(getAgentDir(), "pi-response-style.state.json");

  let styles: Style[] = [];
  let active: string | null = null;
  let sessionPick: SessionPick | undefined;

  function refreshStyles(ctx?: ExtensionContext): void {
    // Project styles only load from a trusted project: an untrusted repo must
    // not shadow a named style that lastUsed/default could resolve to.
    const projectDir = ctx?.isProjectTrusted()
      ? join(ctx.cwd, CONFIG_DIR_NAME, "response-styles")
      : undefined;
    const result = loadStyles(BUNDLED_STYLES_DIR, userStylesDir, projectDir);
    styles = result.styles;
    for (const warning of result.warnings) ctx?.ui.notify(warning, "warning");
  }

  function styleByName(name: string): Style | undefined {
    return styles.find((style) => style.name === name);
  }

  function syncUi(ctx: ExtensionContext): void {
    const style = active === null ? undefined : styleByName(active);
    const defaultName = readDefaultName(userStylesDir);
    // The default style is the baseline and stays invisible; only a style that
    // differs from the default earns a quiet footer marker (title, no prefix).
    const differs = style !== undefined && active !== defaultName;
    ctx.ui.setStatus(STATUS_KEY, differs ? style.title : undefined);
    // Other extensions (e.g. a custom footer) can render this their own way.
    pi.events.emit("pi-response-style:changed", {
      name: style?.name ?? null,
      title: style?.title ?? null,
      defaultName,
    });
  }

  function resolve(ctx: ExtensionContext): void {
    const result = resolveActive({
      pick: sessionPick,
      defaultName: readDefaultName(userStylesDir),
      lastUsed: readLastUsed(stateFile),
      styleNames: styles.map((style) => style.name),
    });
    active = result.active;
    if (result.warning) ctx.ui.notify(result.warning, "warning");
    syncUi(ctx);
  }

  function pickStyle(ctx: ExtensionCommandContext, style: Style): void {
    sessionPick = { name: style.name };
    active = style.name;
    pi.appendEntry(STATE_TYPE, sessionPick);
    try {
      writeLastUsed(stateFile, style.name);
    } catch {
      ctx.ui.notify("Could not save last-used response style.", "warning");
    }
    syncUi(ctx);
    ctx.ui.notify(`Response style: ${style.title}`, "info");
  }

  function pickOff(ctx: ExtensionCommandContext): void {
    sessionPick = { name: null };
    active = null;
    pi.appendEntry(STATE_TYPE, sessionPick);
    syncUi(ctx);
    ctx.ui.notify("Response style off", "info");
  }

  async function offerDefault(
    ctx: ExtensionCommandContext,
    style: Style,
  ): Promise<void> {
    if (
      await ctx.ui.confirm(
        "Default style",
        `Also make "${style.title}" your default?`,
      )
    ) {
      try {
        writeDefaultName(userStylesDir, style.name);
      } catch {
        ctx.ui.notify("Could not save default response style.", "warning");
        return;
      }
      // Becoming the default hides the footer marker.
      syncUi(ctx);
      ctx.ui.notify(`Default response style: ${style.title}`, "info");
    }
  }

  pi.registerCommand("response-style", {
    description: "Pick the chat response style (thinking traces stay unstyled)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = ["off", ...styles.map((style) => style.name)].map(
        (value) => ({
          value,
          label: value,
        }),
      );
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      refreshStyles(ctx);
      const arg = args.trim();

      if (arg) {
        if (arg === "off") {
          pickOff(ctx);
          return;
        }
        const style = styleByName(arg);
        if (!style) {
          ctx.ui.notify(
            `Unknown style "${arg}". Available: ${styles.map((s) => s.name).join(", ")}, off`,
            "warning",
          );
          return;
        }
        pickStyle(ctx, style);
        await offerDefault(ctx, style);
        return;
      }

      let pickedName: string | null;
      if (ctx.mode === "tui") {
        pickedName = await showStylePicker(
          ctx,
          buildPickerItems(styles, active, readDefaultName(userStylesDir)),
        );
      } else {
        // Non-TUI fallback: plain select over the same items.
        const items = buildPickerItems(
          styles,
          active,
          readDefaultName(userStylesDir),
        );
        const baseLabels = items.map(
          (item) => `${item.label} — ${item.description}`,
        );
        const labelCounts = new Map<string, number>();
        for (const label of baseLabels) {
          labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        }
        const labels = baseLabels.map((label, index) =>
          labelCounts.get(label)! > 1
            ? `${label} [${items[index]!.value}]`
            : label,
        );
        const choice = await ctx.ui.select("Response style:", labels);
        if (choice === undefined) {
          pickedName = null;
        } else {
          const firstMatch = labels.indexOf(choice);
          // A disambiguated duplicate label can itself collide with another
          // style's rendered label; never guess which row was picked.
          if (firstMatch !== -1 && labels.lastIndexOf(choice) !== firstMatch) {
            ctx.ui.notify(
              "That selection matches more than one style; rename one of the duplicates.",
              "warning",
            );
            pickedName = null;
          } else {
            pickedName =
              firstMatch === -1 ? null : (items[firstMatch]?.value ?? null);
          }
        }
      }
      if (pickedName === null) {
        ctx.ui.notify("Response style unchanged", "info");
        return;
      }
      if (pickedName === OFF_VALUE) {
        pickOff(ctx);
        return;
      }
      const style = styleByName(pickedName);
      if (!style) return; // styles changed between listing and pick
      pickStyle(ctx, style);
      await offerDefault(ctx, style);
    },
  });

  pi.on("before_agent_start", (event) => {
    if (active === null) return;
    const style = styleByName(active);
    if (!style) return;
    return { systemPrompt: event.systemPrompt + buildInjection(style) };
  });

  pi.on("session_start", (_event, ctx) => {
    refreshStyles(ctx);
    // Newest pick on the active branch wins; { name: null } is an explicit off.
    sessionPick = ctx.sessionManager
      .getBranch()
      .filter(
        (entry): entry is CustomEntry<SessionPick> =>
          entry.type === "custom" &&
          entry.customType === STATE_TYPE &&
          isSessionPick(entry.data),
      )
      .pop()?.data;
    resolve(ctx);
  });

  pi.on("session_compact", () => {
    // Custom entries can be compaction cut points; re-persist the pick.
    if (sessionPick !== undefined) pi.appendEntry(STATE_TYPE, sessionPick);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  refreshStyles();
}
