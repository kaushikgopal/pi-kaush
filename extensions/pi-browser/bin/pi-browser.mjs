#!/usr/bin/env node
/**
 * pi-browser CLI — harness-agnostic front-end for OpenCode/Codex skills.
 *
 *   pi-browser session new <name> [--read-only]
 *   pi-browser session list
 *   pi-browser session delete <name>
 *   pi-browser execute --session <name> [--params <json>] '<code>'
 *   pi-browser status
 *
 * Sessions persist as tabs across CLI processes (daemon-owned). `execute`
 * runs the code as an async function body with { page, client, fs, params }
 * in scope and prints a JSON envelope: { ok: true, value } | { ok: false, error }.
 *
 * Requires Node >= 23.6 (native type stripping for the core .ts modules).
 */

const client = await import(new URL("../src/core/client.ts", import.meta.url));

const envelope = (ok, payload) => {
  process.stdout.write(
    JSON.stringify(
      ok ? { ok: true, value: payload } : { ok: false, error: payload },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = ok ? 0 : 1;
};

const usage = (msg) => {
  envelope(
    false,
    `${msg}\ncommands: session new <name> [--read-only] | session list | session delete <name> | execute [--session <name>] [--params <json>] '<code>' | status`,
  );
};

const main = async () => {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "status") {
    envelope(true, await client.request("status"));
    return;
  }

  if (cmd === "session") {
    const [sub, ...rest] = args;
    if (sub === "new") {
      const name = rest[0];
      if (!name) return usage("session new needs a name");
      envelope(
        true,
        await client.request("sessionNew", {
          name,
          readOnly: rest.includes("--read-only"),
        }),
      );
      return;
    }
    if (sub === "list") {
      envelope(true, await client.request("sessionList"));
      return;
    }
    if (sub === "delete") {
      const name = rest[0];
      if (!name) return usage("session delete needs a name");
      envelope(true, await client.request("sessionDelete", { name }));
      return;
    }
    return usage(`unknown session subcommand: ${sub ?? "(missing)"}`);
  }

  if (cmd === "execute") {
    let sessionName = null;
    let paramsJson = null;
    const codeParts = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--session") sessionName = args[++i] ?? null;
      else if (arg === "--params") paramsJson = args[++i] ?? null;
      else codeParts.push(arg);
    }
    const code = codeParts.join(" ").trim();
    if (!code) return usage("execute needs code");
    let params;
    try {
      params = paramsJson ? JSON.parse(paramsJson) : undefined;
    } catch {
      return envelope(false, "--params must be valid JSON");
    }
    if (sessionName) {
      envelope(
        true,
        await client.request(
          "sessionExecute",
          { name: sessionName, code, params },
          615_000,
        ),
      );
    } else {
      envelope(
        true,
        await client.request("execute", { code, params }, 615_000),
      );
    }
    return;
  }

  return usage(`unknown command: ${cmd ?? "(missing)"}`);
};

main()
  .catch((error) =>
    envelope(false, error instanceof Error ? error.message : String(error)),
  )
  .finally(() => process.exit(process.exitCode ?? 0));
