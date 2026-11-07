#!/usr/bin/env bash
# Publish a pi-kaush package to npm via GitHub Actions OIDC.
#
# Usage:
#   make publish PACKAGE=pi-openai-compaction # patch bump
#   make publish PACKAGE=pi-verbatim-compaction # patch bump
#   make publish PACKAGE=pi-btw               # patch bump
#   make publish PACKAGE=pi-content-layout    # patch bump
#   make publish PACKAGE=pi-agent-mode        # patch bump
#   make publish PACKAGE=pi-inline-identifier # patch bump
#   make publish PACKAGE=pi-btw VERSION=0.2.0 # explicit version
#
# Prerequisites:
#   - jq, gh (authenticated), npm
#   - Clean git working tree (commit your code changes first)
#   - Package must already exist on npm with a trusted publisher configured.

set -euo pipefail

PACKAGE="${1:-}"
VERSION="${2:-}"

if [ -z "$PACKAGE" ]; then
  echo "Usage: make publish PACKAGE=<package-name> [VERSION=<x.y.z>]" >&2
  echo "Known packages: firefox-agent-core, pi-firefox, pi-agent-mode, pi-better-read-edit, pi-browser, pi-btw, pi-content-layout, pi-double-paste, pi-footer-minimal, pi-inline-identifier, pi-intercom-hotkey, pi-model-profiles, pi-response-style, pi-simple-subagents, pi-tool-call-markers, pi-verbatim-compaction, pi-welcome-screen" >&2
  exit 1
fi

case "$PACKAGE" in
  firefox-agent-core) DIR="packages/firefox-agent-core" ;;
  *) DIR="extensions/$PACKAGE" ;;
esac
PKG_FILE="$DIR/package.json"

if [ ! -f "$PKG_FILE" ]; then
  echo "Error: $PKG_FILE not found." >&2
  exit 1
fi

# --- Pre-flight checks ------------------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: Working tree is not clean. Commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

git fetch origin main
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "Error: HEAD must contain the latest origin/main before publishing." >&2
  exit 1
fi

# The adapter must never be released before its declared core range exists.
if [ "$PACKAGE" = "pi-firefox" ]; then
  CORE_RANGE=$(jq -r '.dependencies["@pi-kaush/firefox-agent-core"]' "$PKG_FILE")
  if ! npm view "@pi-kaush/firefox-agent-core@$CORE_RANGE" version --json; then
    echo "Error: publish firefox-agent-core for $CORE_RANGE before pi-firefox." >&2
    exit 1
  fi
fi

# --- Resolve version --------------------------------------------------------

PKG_NAME=$(jq -r '.name' "$PKG_FILE")
CURRENT=$(jq -r '.version' "$PKG_FILE")

if [ -n "$VERSION" ]; then
  NEW_VERSION="$VERSION"
else
  IFS='.' read -r major minor patch <<<"$CURRENT"
  NEW_VERSION="$major.$minor.$((patch + 1))"
fi

if [ "$CURRENT" = "$NEW_VERSION" ]; then
  echo "Error: $PKG_NAME is already at $NEW_VERSION." >&2
  exit 1
fi

echo "Publishing $PKG_NAME: $CURRENT -> $NEW_VERSION"

# --- Bump, check, commit, push, release -------------------------------------

tmp=$(mktemp)
jq --arg v "$NEW_VERSION" '.version = $v' "$PKG_FILE" >"$tmp" && mv "$tmp" "$PKG_FILE"

npm run check

TAG="$PACKAGE-v$NEW_VERSION"
git add "$PKG_FILE"
git commit -m "release: $PKG_NAME@$NEW_VERSION"
# Publish the checked-out commit even when running from a clean Graft branch.
# A concurrent origin/main update still fails safely as a non-fast-forward push.
git push origin HEAD:main

gh release create "$TAG" \
  --target main \
  --title "$TAG" \
  --notes "Release $PKG_NAME@$NEW_VERSION" \
  --latest

echo ""
echo "Done. Release $TAG created."
echo "GitHub Actions will publish $PKG_NAME@$NEW_VERSION to npm via OIDC."
echo "Watch: gh run watch"
