import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
	shouldIsolateSubagentProcess,
	SubagentProcessRegistry,
	type RegisteredSubagentProcess,
} from "../src/_process-tree";

interface SpawnedTree {
	proc: ChildProcess;
	handle: RegisteredSubagentProcess;
	parentPid: number;
	leafPid: Promise<number>;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return Boolean(error && typeof error === "object" && "code" in error && error.code !== "ESRCH");
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for process state");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function firstJsonLine(proc: ChildProcess): Promise<{ leafPid: number }> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		proc.stdout?.on("data", (chunk) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				resolve(JSON.parse(buffer.slice(0, newline)));
			} catch (error) {
				reject(error);
			}
		});
		proc.once("error", reject);
		proc.once("close", (code) => reject(new Error(`Process closed before announcing its child (${code})`)));
	});
}

function spawnTree(registry: SubagentProcessRegistry, ignoreTerm = false): SpawnedTree {
	const termHandler = ignoreTerm ? 'process.on("SIGTERM", () => {});' : "";
	const leafScript = `${termHandler} setInterval(() => {}, 1_000);`;
	const parentScript = `
		const { spawn } = require("node:child_process");
		${termHandler}
		const leaf = spawn(process.execPath, ["-e", ${JSON.stringify(leafScript)}], { stdio: "ignore" });
		process.stdout.write(JSON.stringify({ leafPid: leaf.pid }) + "\\n");
		setInterval(() => {}, 1_000);
	`;
	const proc = spawn(process.execPath, ["-e", parentScript], {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (proc.pid === undefined) throw new Error("Spawned process has no pid");
	const handle = registry.register(proc, true);
	proc.once("exit", () => handle.complete());
	proc.once("close", () => handle.complete());
	proc.once("error", () => handle.complete());
	return {
		proc,
		handle,
		parentPid: proc.pid,
		leafPid: firstJsonLine(proc).then((line) => line.leafPid),
	};
}

async function forceCleanup(tree: SpawnedTree | undefined): Promise<void> {
	if (!tree) return;
	const leafPid = await tree.leafPid.catch(() => undefined);
	for (const pid of [tree.parentPid, leafPid]) {
		if (pid === undefined) continue;
		for (const target of [-pid, pid]) {
			try {
				process.kill(target, "SIGKILL");
			} catch {
				// Already gone or not a process-group leader.
			}
		}
	}
	await tree.handle.done;
}

describe("subagent process trees", () => {
	test("isolates only depth-1 children on POSIX", () => {
		expect(shouldIsolateSubagentProcess(1, "darwin")).toBe(true);
		expect(shouldIsolateSubagentProcess(2, "darwin")).toBe(false);
		expect(shouldIsolateSubagentProcess(1, "win32")).toBe(false);
	});

	if (process.platform !== "win32") {
		test("preserves normal output and completion", async () => {
			const registry = new SubagentProcessRegistry(process.platform, 100);
			const script = `
				const { spawn } = require("node:child_process");
				const leaf = spawn(process.execPath, ["-e", "console.log('leaf:done')"], { stdio: ["ignore", "pipe", "ignore"] });
				leaf.stdout.pipe(process.stdout);
				leaf.on("close", () => console.log("parent:done"));
			`;
			const proc = spawn(process.execPath, ["-e", script], {
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
			let output = "";
			proc.stdout?.on("data", (chunk) => (output += chunk.toString()));
			const handle = registry.register(proc, true);
			const exitCode = await new Promise<number>((resolve, reject) => {
				proc.once("close", (code) => {
					handle.complete();
					resolve(code ?? 0);
				});
				proc.once("error", reject);
			});
			await handle.done;

			expect(exitCode).toBe(0);
			expect(output).toContain("leaf:done");
			expect(output).toContain("parent:done");
			expect(registry.size).toBe(0);
		});

		test("cleans descendants left behind by a completed group leader", async () => {
			const registry = new SubagentProcessRegistry(process.platform, 100);
			const leafScript = "setInterval(() => {}, 1_000);";
			const parentScript = `
				const { spawn } = require("node:child_process");
				const leaf = spawn(process.execPath, ["-e", ${JSON.stringify(leafScript)}], { stdio: ["ignore", "inherit", "ignore"] });
				leaf.unref();
				process.stdout.write(JSON.stringify({ leafPid: leaf.pid }) + "\\n");
			`;
			const proc = spawn(process.execPath, ["-e", parentScript], {
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (proc.pid === undefined) throw new Error("Spawned process has no pid");
			const parentPid = proc.pid;
			const handle = registry.register(proc, true);
			proc.once("exit", () => handle.complete());
			proc.once("close", () => handle.complete());
			proc.once("error", () => handle.complete());
			const { leafPid } = await firstJsonLine(proc);

			try {
				await handle.done;
				await waitFor(() => !processExists(leafPid));
				expect(registry.size).toBe(0);
			} finally {
				try {
					process.kill(-parentPid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		});

		test("forces a resistant nested descendant without killing its sibling", async () => {
			const registry = new SubagentProcessRegistry(process.platform, 100);
			const leafScript = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);';
			const nestedScript = `
				const { spawn } = require("node:child_process");
				const leaf = spawn(process.execPath, ["-e", ${JSON.stringify(leafScript)}], { stdio: "ignore" });
				process.stdout.write(JSON.stringify({ leafPid: leaf.pid }) + "\\n");
				setInterval(() => {}, 1_000);
			`;
			const nested = spawn(process.execPath, ["-e", nestedScript], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
				stdio: "ignore",
			});
			if (nested.pid === undefined || sibling.pid === undefined) throw new Error("Spawned process has no pid");
			const nestedPid = nested.pid;
			const siblingPid = sibling.pid;
			const handle = registry.register(nested, false);
			nested.once("exit", () => handle.complete());
			nested.once("close", () => handle.complete());
			nested.once("error", () => handle.complete());
			const { leafPid } = await firstJsonLine(nested);

			try {
				handle.terminate();
				await handle.done;
				await waitFor(() => !processExists(nestedPid) && !processExists(leafPid));
				expect(processExists(siblingPid)).toBe(true);
			} finally {
				for (const pid of [nestedPid, leafPid, siblingPid]) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Already gone.
					}
				}
			}
		});
		test("kills one forced subtree without affecting its sibling, then cleans up on shutdown", async () => {
			const registry = new SubagentProcessRegistry(process.platform, 100);
			let first: SpawnedTree | undefined;
			let sibling: SpawnedTree | undefined;
			try {
				first = spawnTree(registry, true);
				sibling = spawnTree(registry);
				const [firstLeafPid, siblingLeafPid] = await Promise.all([first.leafPid, sibling.leafPid]);

				first.handle.terminate();
				await first.handle.done;
				await waitFor(() => !processExists(first!.parentPid) && !processExists(firstLeafPid));

				expect(processExists(sibling.parentPid)).toBe(true);
				expect(processExists(siblingLeafPid)).toBe(true);

				await registry.terminateAll();
				expect(sibling.handle.shutdownRequested).toBe(true);
				await waitFor(() => !processExists(sibling!.parentPid) && !processExists(siblingLeafPid));
				expect(registry.size).toBe(0);
				expect(registry.isShuttingDown).toBe(true);
			} finally {
				await forceCleanup(first);
				await forceCleanup(sibling);
			}
		});
	}
});
