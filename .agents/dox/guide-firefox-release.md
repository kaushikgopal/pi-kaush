# Firefox package release guide

Use this guide to prepare the first public releases of `@pi-kaush/firefox-agent-core` and `@pi-kaush/pi-firefox`. Do not use the automated release target for either first publication.

## First publication

Use reviewed, committed source. Confirm the GitHub repository contains that source before configuring trusted publishing. These steps publish packages; do not run them during release preparation.

1. Confirm that both package versions are `0.1.0` and that the adapter depends on core `^0.1.0`.
2. From the repository root, install locked dependencies and build the core explicitly.

```fish
npm ci --ignore-scripts
npm run build --workspace @pi-kaush/firefox-agent-core
npm run check
```

The repository ignores lifecycle scripts. The core publish therefore cannot rely on `prepublishOnly` or another build hook. The explicit build must finish before publication.

3. Publish the core package manually. Authenticate to npm and complete its browser-based 2FA challenge.

```fish
npm publish ./packages/firefox-agent-core --access public --ignore-scripts
```

4. Verify that npm serves core version `0.1.0`.

```fish
npm view @pi-kaush/firefox-agent-core version
```

5. Configure the core package's npm Trusted Publisher with these values:

   - Provider: GitHub Actions
   - Owner: `kaushikgopal`
   - Repository: `pi-kaush`
   - Workflow: `publish.yml`
   - GitHub environment: `npm`

6. Publish the adapter manually after the core is available. Authenticate to npm and complete its browser-based 2FA challenge.

```fish
npm publish ./extensions/pi-firefox --access public --ignore-scripts
```

7. Configure the adapter package's npm Trusted Publisher with the same GitHub Actions owner, repository, workflow, and `npm` environment.
8. Verify both package versions.

```fish
npm view @pi-kaush/firefox-agent-core version
npm view @pi-kaush/pi-firefox version
```

9. Smoke-test Pi installation after both packages are public.

```fish
pi install npm:@pi-kaush/pi-firefox
```

In Pi, run `/reload`, then `/firefox-status`. Install and pair `firefox-cli@0.4.1` manually before testing browser access. Package installation does not install or pair Firefox or its native bridge.

## Later releases

After both npm Trusted Publishers are configured, use the repository release target for subsequent versions:

```fish
make publish PACKAGE=firefox-agent-core
make publish PACKAGE=pi-firefox
```

The target bumps the package version, runs checks, commits, pushes to `main`, and creates a GitHub release. It is not a first-publication command. Do not use it to bootstrap version `0.1.0`.

## Platform evidence

Live Firefox validation covers macOS with Node 26.12.1, Firefox 158.0.1, and `firefox-cli` 0.4.1. Linux identity code paths and CI unit checks do not establish live Firefox support. Persistent browser control on Windows is unsupported. Node 20 execution is not verified; Pi 1.x requires Node 22.19.0 or newer.
