export interface SubagentConcurrencyStatus {
	active: number;
	queued: number;
	limit: number;
	available: number;
}

interface PendingAcquire {
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	settled: boolean;
}

export class SessionConcurrencyGate {
	private active = 0;
	private readonly queue: PendingAcquire[] = [];
	private closedError?: string;

	constructor(readonly limit: number) {}

	get status(): SubagentConcurrencyStatus {
		return {
			active: this.active,
			queued: this.queue.filter((pending) => !pending.settled).length,
			limit: this.limit,
			available: Math.max(0, this.limit - this.active),
		};
	}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (this.closedError) return Promise.reject(new Error(this.closedError));
		if (signal?.aborted) return Promise.reject(new Error("Subagent was aborted before it started."));
		if (this.active < this.limit) {
			this.active++;
			return Promise.resolve(this.createRelease());
		}

		return new Promise((resolve, reject) => {
			const pending: PendingAcquire = { resolve, reject, signal, settled: false };
			if (signal) {
				pending.onAbort = () => {
					if (pending.settled) return;
					pending.settled = true;
					const index = this.queue.indexOf(pending);
					if (index >= 0) this.queue.splice(index, 1);
					reject(new Error("Subagent was aborted before it started."));
				};
				signal.addEventListener("abort", pending.onAbort, { once: true });
			}
			this.queue.push(pending);
		});
	}

	close(message = "Subagent did not start because the session is shutting down."): void {
		if (this.closedError) return;
		this.closedError = message;
		for (const pending of this.queue.splice(0)) {
			if (pending.settled) continue;
			pending.settled = true;
			this.removeAbortListener(pending);
			pending.reject(new Error(message));
		}
	}

	private createRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active = Math.max(0, this.active - 1);
			this.drain();
		};
	}

	private drain(): void {
		while (!this.closedError && this.active < this.limit && this.queue.length > 0) {
			const pending = this.queue.shift()!;
			if (pending.settled) continue;
			if (pending.signal?.aborted) {
				pending.settled = true;
				this.removeAbortListener(pending);
				pending.reject(new Error("Subagent was aborted before it started."));
				continue;
			}
			pending.settled = true;
			this.removeAbortListener(pending);
			this.active++;
			pending.resolve(this.createRelease());
		}
	}

	private removeAbortListener(pending: PendingAcquire): void {
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
	}
}
