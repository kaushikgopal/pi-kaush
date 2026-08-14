/**
 * `/agent` — activate a configured Pi agent as a persistent mode in the
 * current session.
 *
 * This package is a mode on the current agent session: it switches model,
 * thinking level, and active tools, appends the agent prompt to the base
 * prompt, and restores the pre-activation baseline on `/agent none` or
 * `/agent off`. It does not spawn children and provides no delegated
 * subagents.
 */

import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  discoverAgents,
  formatAgentDisplayName,
  shouldConfirmProjectAgent,
  type AgentConfig,
} from "./agent-discovery.ts";
import { parseAgentModelSpec, type ThinkingLevel } from "./model-spec.ts";
import {
  buildAgentPickerItems,
  NONE_VALUE,
  showAgentPicker,
} from "./agent-picker.ts";

interface ModelReference {
  provider: string;
  id: string;
}

export interface AgentModelSpec {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export { parseAgentModelSpec };

// Durable session state is namespaced so it cannot collide with other
// packages. Legacy Aikado sessions wrote `active-agent-state`; restore reads
// both types and prefers the newest recognized entry on the active branch so
// sessions activated by either implementation resume correctly.
const PI_AGENT_MODE_STATE_TYPE = "pi-agent-mode/state";
const LEGACY_ACTIVE_AGENT_STATE_TYPE = "active-agent-state";
const ACTIVE_AGENT_STATE_TYPES = [
  LEGACY_ACTIVE_AGENT_STATE_TYPE,
  PI_AGENT_MODE_STATE_TYPE,
];

interface AgentBaseline {
  model?: ModelReference;
  thinkingLevel: ThinkingLevel;
  tools: string[];
}

interface ActiveAgent {
  agent: AgentConfig;
  baseline: AgentBaseline;
}

interface ActiveAgentState {
  active: boolean;
  name?: string;
  baseline?: AgentBaseline;
}

export function registerAgentMode(pi: ExtensionAPI) {
  let activeAgent: ActiveAgent | undefined;

  function getBaseline(ctx: ExtensionContext): AgentBaseline {
    return {
      ...(ctx.model
        ? { model: { provider: ctx.model.provider, id: ctx.model.id } }
        : {}),
      thinkingLevel: pi.getThinkingLevel(),
      tools: pi.getActiveTools(),
    };
  }

  function updateAgentStatus(ctx: ExtensionContext) {
    if (!activeAgent) {
      ctx.ui.setStatus("active-agent", undefined);
      return;
    }

    ctx.ui.setStatus(
      "active-agent",
      ctx.ui.theme.bold(
        ctx.ui.theme.fg("warning", formatAgentDisplayName(activeAgent.agent)),
      ),
    );
  }

  function persistActiveAgent() {
    const state: ActiveAgentState = activeAgent
      ? {
          active: true,
          name: activeAgent.agent.name,
          baseline: activeAgent.baseline,
        }
      : { active: false };
    pi.appendEntry(PI_AGENT_MODE_STATE_TYPE, state);
  }

  function findModel(modelSpec: string, ctx: ExtensionContext) {
    const spec = modelSpec.trim();
    const separator = spec.indexOf("/");
    if (separator > 0 && separator < spec.length - 1) {
      return ctx.modelRegistry.find(
        spec.slice(0, separator),
        spec.slice(separator + 1),
      );
    }

    const matches = ctx.modelRegistry
      .getAll()
      .filter((model) => model.id === spec || model.name === spec);
    return (
      matches.find((model) => model.provider === ctx.model?.provider) ??
      matches[0]
    );
  }

  async function restoreModel(
    model: ModelReference | undefined,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    if (!model) return true;
    if (ctx.model?.provider === model.provider && ctx.model.id === model.id)
      return true;

    const resolved = ctx.modelRegistry.find(model.provider, model.id);
    if (!resolved) {
      ctx.ui.notify(
        `Cannot restore model ${model.provider}/${model.id}: it is no longer available.`,
        "warning",
      );
      return false;
    }
    if (await pi.setModel(resolved)) return true;

    ctx.ui.notify(
      `Cannot restore model ${model.provider}/${model.id}: authentication is unavailable.`,
      "warning",
    );
    return false;
  }

  function applyAgentTools(
    agent: AgentConfig,
    baseline: AgentBaseline,
    ctx: ExtensionContext,
  ) {
    const requested = agent.tools?.length ? agent.tools : baseline.tools;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const valid = requested.filter((tool) => available.has(tool));
    const missing = requested.filter((tool) => !available.has(tool));

    if (missing.length > 0) {
      ctx.ui.notify(
        `Agent ${formatAgentDisplayName(agent)}: unavailable tools ignored: ${missing.join(", ")}`,
        "warning",
      );
    }
    pi.setActiveTools(valid);
  }

  async function activateAgent(
    agent: AgentConfig,
    ctx: ExtensionContext,
    baseline = activeAgent?.baseline ?? getBaseline(ctx),
    persist = true,
  ): Promise<boolean> {
    baseline = {
      ...baseline,
      thinkingLevel: baseline.thinkingLevel ?? pi.getThinkingLevel(),
    };
    let thinkingLevel = baseline.thinkingLevel;
    if (agent.model) {
      const modelSpec = parseAgentModelSpec(agent.model);
      const model = findModel(modelSpec.model, ctx);
      if (!model) {
        ctx.ui.notify(
          `Agent ${formatAgentDisplayName(agent)}: configured model "${agent.model}" was not found.`,
          "error",
        );
        return false;
      }
      if (!(await pi.setModel(model))) {
        ctx.ui.notify(
          `Agent ${formatAgentDisplayName(agent)}: authentication is unavailable for ${agent.model}.`,
          "error",
        );
        return false;
      }
      thinkingLevel = modelSpec.thinkingLevel ?? baseline.thinkingLevel;
    } else {
      await restoreModel(baseline.model, ctx);
    }

    pi.setThinkingLevel(thinkingLevel);
    applyAgentTools(agent, baseline, ctx);
    activeAgent = { agent, baseline };
    updateAgentStatus(ctx);
    if (persist) persistActiveAgent();
    return true;
  }

  async function clearActiveAgent(ctx: ExtensionContext) {
    if (!activeAgent) {
      ctx.ui.notify("No active agent.", "info");
      return;
    }

    await restoreModel(activeAgent.baseline.model, ctx);
    pi.setThinkingLevel(activeAgent.baseline.thinkingLevel);
    pi.setActiveTools(activeAgent.baseline.tools);
    activeAgent = undefined;
    updateAgentStatus(ctx);
    persistActiveAgent();
    ctx.ui.notify(
      "Active agent cleared; previous model and tools restored.",
      "info",
    );
  }

  async function confirmProjectAgent(
    agent: AgentConfig,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    if (
      agent.source !== "project" ||
      !ctx.hasUI ||
      !shouldConfirmProjectAgent(agent)
    )
      return true;
    return ctx.ui.confirm(
      "Activate project-local agent?",
      `Agent: ${formatAgentDisplayName(agent)}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled. Only continue for trusted projects.`,
    );
  }

  pi.registerCommand("agent", {
    description:
      "Activate a named agent in this session; use /agent none to restore defaults",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested === "none" || requested === "off") {
        await clearActiveAgent(ctx);
        return;
      }

      const agents = discoverAgents(ctx.cwd, "both").agents;
      if (agents.length === 0) {
        ctx.ui.notify("No agents found.", "warning");
        return;
      }

      let agent: AgentConfig | undefined;
      if (requested) {
        agent = agents.find((candidate) => candidate.name === requested);
        if (!agent) {
          ctx.ui.notify(
            `Unknown agent "${requested}". Available: ${agents.map((candidate) => formatAgentDisplayName(candidate)).join(", ")}`,
            "warning",
          );
          return;
        }
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `Usage: /agent <name|none>. Available: ${agents.map((agent) => formatAgentDisplayName(agent)).join(", ")}`,
            "info",
          );
          return;
        }
        let picked: string | null;
        if (ctx.mode === "tui") {
          picked = await showAgentPicker(
            ctx,
            buildAgentPickerItems(agents, activeAgent?.agent.name),
          );
        } else {
          const items = buildAgentPickerItems(agents, activeAgent?.agent.name);
          const labels = items.map(
            (item) => `${item.label} — ${item.description}`,
          );
          const choice = await ctx.ui.select("Activate agent:", labels);
          picked =
            choice === undefined
              ? null
              : (items[labels.indexOf(choice)]?.value ?? null);
        }
        if (!picked) return;
        if (picked === NONE_VALUE) {
          await clearActiveAgent(ctx);
          return;
        }
        agent = agents.find((candidate) => candidate.name === picked);
      }

      if (!agent || !(await confirmProjectAgent(agent, ctx))) return;
      if (await activateAgent(agent, ctx)) {
        ctx.ui.notify(`Active agent: ${formatAgentDisplayName(agent)}`, "info");
      }
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!activeAgent) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Active agent: ${formatAgentDisplayName(activeAgent.agent)}\nThe following agent definition is active for this session. Follow it in addition to Pi's base instructions and loaded project context.\n\n${activeAgent.agent.systemPrompt}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    activeAgent = undefined;
    const stateEntry = ctx.sessionManager
      .getBranch()
      .filter(
        (entry): entry is CustomEntry<ActiveAgentState> =>
          entry.type === "custom" &&
          ACTIVE_AGENT_STATE_TYPES.includes(entry.customType),
      )
      .pop();
    const state = stateEntry?.data;
    if (!state?.active || !state.name) {
      updateAgentStatus(ctx);
      return;
    }

    const agent = discoverAgents(ctx.cwd, "both").agents.find(
      (candidate) => candidate.name === state.name,
    );
    if (!agent) {
      ctx.ui.notify(
        `Active agent "${state.name}" is no longer available.`,
        "warning",
      );
      updateAgentStatus(ctx);
      return;
    }

    await activateAgent(agent, ctx, state.baseline ?? getBaseline(ctx), false);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("active-agent", undefined);
  });
}

// Pi loads the package as an extension through this default factory.
export default async function (pi: ExtensionAPI) {
  registerAgentMode(pi);
}
