#!/usr/bin/env node
// pi-browser daemon entry. Normally spawned by the client on demand.
await import("../src/daemon.ts");
