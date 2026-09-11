export interface AgentIdentity {
	name: string;
	emoji?: string;
}

export function formatAgentDisplayName(agent: AgentIdentity): string {
	const emoji = agent.emoji?.trim();
	return emoji ? `${emoji} ${agent.name}` : agent.name;
}

export function resolveAgentDisplayName(name: string, agents: readonly AgentIdentity[]): string {
	return formatAgentDisplayName(agents.find((agent) => agent.name === name) ?? { name });
}

export function formatProfileDisplayName(profile: string | undefined): string {
	const name = profile?.trim();
	return name ? `[${name}]` : "";
}
