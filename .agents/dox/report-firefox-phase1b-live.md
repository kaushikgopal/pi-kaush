# Phase 1B live smoke

## Result

Passed against Firefox 158.0.1 and firefox-cli 0.4.1 on Brainiac. The test used only synthetic loopback pages outside the temporary CTC routing patterns. No real-account page content was read.

## Observed checks

- Core created a new background tab with verified default-container metadata.
- Repeated ensure reused the same owned tab.
- Read returned a ref-free summary within a 512-byte summary budget. This fixture's serialized summary was 118 bytes; this is not a representative token benchmark.
- Navigation retained the owned tab and omitted query strings from result URLs.
- Close removed only the owned tab; read after close failed.
- Two independent sessions opened distinct tabs concurrently and both read successfully.
- The real public Pi loader loaded the adapter. `ff_session_ensure`, `ff_read`, `ff_go`, and `ff_session_close` ran successfully through their actual tool definitions without a model request.
- The original tab IDs before and after the run matched.
- All test tabs closed and the fixture server stopped.

## Reproduction

After approved Firefox pairing, run from the repository root:

```fish
npm run build --workspace @pi-kaush/firefox-core
node .agents/dox/test-firefox-phase1b-live.mjs
```

The script binds only `127.0.0.1:48765`. It refuses an occupied port instead of stopping another process. It requires one unambiguous normal window. It does not adopt a CTC replacement without approval.

## Not established

This smoke does not validate restart survival, cross-process coordination, a live terminal confirmation dialog, new CTC replacement adoption through the final wrapper, private access, or Node 20 runtime behavior. Prior backend tests establish CTC replacement detection and cookie isolation; unit tests establish the wrapper's confirmation logic. Full representative token measurements remain a later phase.
