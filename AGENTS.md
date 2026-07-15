# Repository guidance

- Keep Pi extensions composable and limited to public Pi APIs.
- Do not replace the input editor unless the package's explicit purpose requires it.
- Keep runtime dependencies at zero where practical.
- Add regression tests for input handling and extension interoperability.
- Run `npm run check` before claiming a change is complete.
- Do not commit, push, publish, or create a release unless explicitly asked.

## Publishing

Extensions publish to npm through GitHub Actions using OIDC Trusted Publishing — no local npm login, token, or publish-time 2FA is needed. Each package has a trusted publisher configured on npmjs.com that accepts publishes from `kaushikgopal/pi-kaush` workflow `publish.yml` in the `npm` environment.

To release a new version of an extension (only when explicitly asked):

1. Make sure code changes are committed and the working tree is clean.
2. Run `make publish PACKAGE=<extension-name>` for a patch bump, or `make publish PACKAGE=<extension-name> VERSION=<x.y.z>` for an explicit version.
3. The script bumps `package.json`, runs `npm run check`, commits, pushes to `main`, and creates a GitHub Release with a tag like `pi-split-session-v0.1.1`.
4. The release event triggers `.github/workflows/publish.yml`, which verifies the tag matches the package version, then publishes to npm via OIDC.
5. Monitor with `gh run watch` and verify with `npm view @pi-kaush/<package> version`.

Known publishable packages: `pi-double-paste`, `pi-inline-skill-identifier`, `pi-openai-text-verbosity`, `pi-split-session`, `pi-tool-call-markers`, `pi-welcome-screen`. A package's first release must be bootstrapped with a manual `npm publish` (which requires browser 2FA) before its trusted publisher can be configured; subsequent releases use `make publish`.
