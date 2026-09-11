import { spawnSync, type ChildProcess } from "node:child_process";

export const SUBAGENT_TERMINATION_GRACE_MS = 5_000;
const PROCESS_EXIT_POLL_MS = 50;

export interface RegisteredSubagentProcess {
	terminate(): void;
	complete(): void;
	readonly shutdownRequested: boolean;
	readonly done: Promise<void>;
}

interface ProcessEntry {
	pid: number | undefined;
	isolatedProcessGroup: boolean;
	rootIdentity: string | undefined;
	terminationStarted: boolean;
	shutdownRequested: boolean;
	disposed: boolean;
	descendantIdentities: Map<number, string | undefined>;
	forceTimer?: ReturnType<typeof setTimeout>;
	monitorTimer?: ReturnType<typeof setInterval>;
	resolveDone: () => void;
	done: Promise<void>;
}

function isMissingProcessError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}

/** Depth-1 children lead groups; nested Pi children remain inside that direct-child subtree. */
export function shouldIsolateSubagentProcess(depth: number, platform = process.platform): boolean {
	return platform !== "win32" && depth === 1;
}

function discoverDescendantPids(rootPid: number): number[] {
	const result = spawnSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0 || !result.stdout) return [];

	const childrenByParent = new Map<number, number[]>();
	for (const line of result.stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const parentPid = Number(match[2]);
		const children = childrenByParent.get(parentPid) ?? [];
		children.push(pid);
		childrenByParent.set(parentPid, children);
	}

	const descendants: number[] = [];
	const seen = new Set<number>([rootPid]);
	const visit = (parentPid: number): void => {
		for (const pid of childrenByParent.get(parentPid) ?? []) {
			if (seen.has(pid)) continue;
			seen.add(pid);
			visit(pid);
			descendants.push(pid);
		}
	};
	visit(rootPid);
	return descendants;
}

function processIdentity(pid: number): string | undefined {
	const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const identity = result.status === 0 ? result.stdout.trim() : "";
	return identity || undefined;
}

export class SubagentProcessRegistry {
	private readonly entries = new Set<ProcessEntry>();
	private shuttingDown = false;

	constructor(
		private readonly platform = process.platform,
		private readonly graceMs = SUBAGENT_TERMINATION_GRACE_MS,
	) {}

	get size(): number {
		return this.entries.size;
	}

	get isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	register(proc: ChildProcess, isolatedProcessGroup: boolean): RegisteredSubagentProcess {
		let resolveDone = () => {};
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const entry: ProcessEntry = {
			pid: proc.pid,
			isolatedProcessGroup,
			rootIdentity:
				this.platform !== "win32" && proc.pid !== undefined ? processIdentity(proc.pid) : undefined,
			terminationStarted: false,
			shutdownRequested: false,
			disposed: false,
			descendantIdentities: new Map(),
			resolveDone,
			done,
		};
		this.entries.add(entry);

		return {
			terminate: () => this.terminate(entry),
			complete: () => this.complete(entry),
			get shutdownRequested() {
				return entry.shutdownRequested;
			},
			done,
		};
	}

	async terminateAll(): Promise<void> {
		this.shuttingDown = true;
		const active = [...this.entries];
		for (const entry of active) {
			entry.shutdownRequested = true;
			this.terminate(entry);
		}
		await Promise.all(active.map((entry) => entry.done));
	}

	private complete(entry: ProcessEntry): void {
		if (entry.disposed) return;

		if (this.platform === "win32") {
			// taskkill /T has already received the complete live tree. Do not retain
			// a force timer keyed only by a PID that Windows may quickly reuse.
			this.dispose(entry);
			return;
		}

		if (entry.terminationStarted && this.targetExists(entry)) return;

		if (entry.isolatedProcessGroup && this.targetExists(entry)) {
			// A finished group leader with a live group has orphaned descendants.
			this.terminate(entry);
			return;
		}

		this.dispose(entry);
	}

	private terminate(entry: ProcessEntry): void {
		if (entry.disposed || entry.terminationStarted) return;
		entry.terminationStarted = true;

		const signaled = this.signal(entry, "SIGTERM");
		if (!signaled) {
			this.dispose(entry);
			return;
		}

		if (this.platform !== "win32") this.monitorExit(entry);
		entry.forceTimer = setTimeout(() => {
			if (!entry.disposed) this.signal(entry, "SIGKILL");
			this.dispose(entry);
		}, this.graceMs);
	}

	private monitorExit(entry: ProcessEntry): void {
		if (entry.monitorTimer || entry.disposed) return;
		entry.monitorTimer = setInterval(() => {
			if (!this.targetExists(entry)) this.dispose(entry);
		}, PROCESS_EXIT_POLL_MS);
	}

	private signal(entry: ProcessEntry, signal: "SIGTERM" | "SIGKILL"): boolean {
		if (entry.pid === undefined) return false;

		if (this.platform === "win32") {
			const args = ["/PID", String(entry.pid), "/T"];
			if (signal === "SIGKILL") args.push("/F");
			const result = spawnSync("taskkill", args, {
				stdio: "ignore",
				windowsHide: true,
			});
			if (result.status === 0) return true;

			try {
				return process.kill(entry.pid, signal);
			} catch (error) {
				return !isMissingProcessError(error);
			}
		}

		if (signal === "SIGTERM") {
			for (const pid of discoverDescendantPids(entry.pid)) {
				if (!entry.descendantIdentities.has(pid)) {
					entry.descendantIdentities.set(pid, processIdentity(pid));
				}
			}
		}
		let signaled = false;
		for (const [pid, identity] of entry.descendantIdentities) {
			if (!this.identityMatches(pid, identity)) continue;
			const groupSignaled = this.signalTarget(-pid, signal);
			signaled = groupSignaled || this.signalTarget(pid, signal) || signaled;
		}
		if (entry.isolatedProcessGroup) return this.signalTarget(-entry.pid, signal) || signaled;
		if (signal === "SIGKILL" && !this.identityMatches(entry.pid, entry.rootIdentity)) return signaled;
		return this.signalTarget(entry.pid, signal) || signaled;
	}

	private signalTarget(target: number, signal: "SIGTERM" | "SIGKILL"): boolean {
		try {
			return process.kill(target, signal);
		} catch (error) {
			return !isMissingProcessError(error);
		}
	}

	private targetExists(entry: ProcessEntry): boolean {
		if (entry.pid === undefined) return false;
		const rootTarget = entry.isolatedProcessGroup ? -entry.pid : entry.pid;
		if (this.targetExistsAt(rootTarget)) return true;
		return [...entry.descendantIdentities].some(
			([pid]) => this.targetExistsAt(-pid) || this.targetExistsAt(pid),
		);
	}

	private identityMatches(pid: number, identity: string | undefined): boolean {
		return identity !== undefined && processIdentity(pid) === identity;
	}

	private targetExistsAt(target: number): boolean {
		try {
			process.kill(target, 0);
			return true;
		} catch (error) {
			return !isMissingProcessError(error);
		}
	}

	private dispose(entry: ProcessEntry): void {
		if (entry.disposed) return;
		entry.disposed = true;
		if (entry.forceTimer) clearTimeout(entry.forceTimer);
		if (entry.monitorTimer) clearInterval(entry.monitorTimer);
		this.entries.delete(entry);
		entry.resolveDone();
	}
}
