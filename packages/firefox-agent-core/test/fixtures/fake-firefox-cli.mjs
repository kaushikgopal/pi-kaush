#!/usr/bin/env node
const mode = process.env.FIREFOX_CORE_FIXTURE_MODE ?? "";
const args = process.argv.slice(2);

if (args[0] === "--version") {
  if (mode === "stream") {
    process.stdout.write("x".repeat(4096));
    process.stderr.write("y".repeat(4096));
    process.exit(0);
  }
  if (mode === "hang" || mode === "cancel") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  process.stdout.write("0.4.1\n");
  process.exit(0);
}

if (args[0] === "doctor" && args[1] === "--json") {
  process.stdout.write(
    JSON.stringify({
      nativeHostManifest: { status: "installed" },
      extensionConnection: { status: "connected" },
    }),
  );
  process.exit(0);
}

process.stderr.write("unexpected fixture arguments");
process.exit(2);
