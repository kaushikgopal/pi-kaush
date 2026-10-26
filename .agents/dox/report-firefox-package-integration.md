# Firefox core and adapter packaging reconnaissance

## Result

Use two npm workspaces: `extensions/firefox-core` and `extensions/pi-firefox`. The split is approved; `@pi-kaush/firefox-core` and `@pi-kaush/pi-firefox` remain proposed package names.

Keep CTC authoritative for routing. Use the approved before/after tab comparison and candidate-specific human confirmation baseline. Do not add CTC code, a provenance helper, or a competing router.

This report does not prove Firefox runtime capability. The source-only Phase 0 report, `.agents/dox/report-firefox-phase-0-source-verification.md`, says Firefox and `firefox-cli` were unavailable and no browser commands ran. Phase 1 remains blocked until the live capability gate passes. The existing `package-lock.json` change is unrelated and was not edited.

## Recommended package boundaries

`extensions/firefox-core/` should contain `package.json`, `tsconfig.build.json`, `src/index.ts`, internal `src/*.ts` modules, tests, a package-check script, and generated `dist/`. Keep core independent of Pi and usable from plain Node 20.

Publish core as ESM with `type: module`, `engines.node: >=20`, `dist/index.js` as the runtime entry, and `dist/index.d.ts` as the type entry. Use an `exports` map with only the `.` entry. Do not export source files or wildcard subpaths. Import core only through `@pi-kaush/firefox-core`.

The root `tsconfig.json` uses NodeNext and `noEmit: true`; it permits `.ts` import specifiers for source checking. Do not use those specifiers in compiled core. Use relative `.js` specifiers in TypeScript source. In `tsconfig.build.json`, set `noEmit: false`, `allowImportingTsExtensions: false`, `rootDir: "src"`, `outDir: "dist"`, and declarations on. This keeps emitted imports valid in Node ESM without a loader or path rewrite.

Give core no Pi manifest, no `pi.extensions` field, and no conventional Pi resource directories. Pi package discovery uses manifest paths or conventional resource directories. Keep `extensions/pi-firefox/package.json` as the only Pi extension manifest for this pair, with `pi.extensions: ["./src/index.ts"]`, matching `extensions/pi-browser/package.json`.

The root `package.json` already includes `extensions/*` and requires Node 20. No workspace-glob change is needed. Use a semver dependency range in the adapter that matches the core workspace version, such as `^0.1.0`. This follows `extensions/pi-agent-mode/package.json` and `extensions/pi-simple-subagents/package.json`; `package-lock.json` shows npm links the matching `pi-model-profiles` workspace. Publish core before the adapter version that depends on it.

## Pi tools, commands, and coexistence

The installed public API is Pi 1.0.0. `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` defines TypeBox parameters, `outputSchema`, and `exposure`. `AgentToolResult` in `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` carries `content`, `details`, `structuredContent`, and `isError`.

Give each `ff_*` tool closed TypeBox input and output schemas. Return concise model-facing `content` and matching `structuredContent` for data results. Map expected core failures to `{ ok: false, code, message, recovery }`; return them with `isError: true` so Pi and codemode both preserve the failure. Give `recovery` the exact tool name and valid arguments when recovery exists. Keep approved error codes distinct, including `unverified_container`, `ownership_ambiguous`, `stale_ref`, and `outcome_unknown`.

Use `exposure: "codemode"` for tools intended for script use. Pi documents that this exposure makes registered tools callable and discoverable from codemode, without direct model declarations unless activated. The built-in codemode must be enabled for this path; it is not enabled by default. Do not register another tool named `codemode`.

Existing browser tools use `browser_*`; `extensions/pi-browser/src/commands.ts` owns `/browser-status` and `/browser-profile`. The repository has no `/firefox-*` commands. Use `/firefox-status`, `/firefox-container`, and `/firefox-session`; do not add browser aliases. Phase 1 must test both extensions loaded together.

## Required Phase 1 edits and checks

1. Add core files at `extensions/firefox-core/{package.json,tsconfig.build.json,src/index.ts}`; add implementation modules and focused tests under `src/` and `test/`.
2. Add adapter files at `extensions/pi-firefox/{package.json,src/index.ts,src/tools.ts,src/commands.ts}`; depend on the core public package entry and declare `@earendil-works/pi-coding-agent` and `typebox` as host peers.
3. Add `package:check` scripts and `scripts/check-package.mjs` to both packages. Follow `extensions/pi-btw/scripts/check-package.mjs`: run the core build, run `npm pack --dry-run --json --ignore-scripts`, and compare the exact file list.
4. Check a packed core tarball with plain Node 20. Verify the root import works, declarations ship, and deep imports fail. Check adapter dependency resolution from packed artifacts.
5. Test structured success and failure results, codemode visibility and calls, and coexistence with `pi-browser`. Run `npm run check`.
6. After the live gate clears, probe approved Firefox and CLI capabilities, actual container evidence, and safe replacement confirmation. Report runtime outcomes separately from source findings.

## Evidence paths

Repository conventions reviewed: `package.json`, `tsconfig.json`, `extensions/pi-browser/package.json`, `extensions/pi-browser/src/index.ts`, `extensions/pi-browser/src/commands.ts`, `extensions/pi-btw/package.json`, `extensions/pi-btw/scripts/check-package.mjs`, `extensions/pi-agent-mode/package.json`, `extensions/pi-simple-subagents/package.json`, `extensions/pi-model-profiles/package.json`, and `package-lock.json`.

Pi API and behavior reviewed under `node_modules/@earendil-works/pi-coding-agent/`: `docs/extensions.md`, `docs/codemode.md`, `docs/packages.md`, `docs/settings.md`, `docs/configuration.md`, `docs/cli.md`, `examples/extensions/hello.ts`, `examples/extensions/dynamic-tools.ts`, and `examples/extensions/truncated-tool.ts`. The installed declaration paths appear above.
