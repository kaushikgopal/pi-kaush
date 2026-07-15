#!/usr/bin/env bash
# Publish a pi-kaush extension to npm via GitHub Actions OIDC.
#
# Usage:
#   make publish PACKAGE=pi-split-session               # patch bump
#   make publish PACKAGE=pi-split-session VERSION=0.2.0 # explicit version
#
# Prerequisites:
#   - jq, gh (authenticated), npm
#   - Clean git working tree (commit your code changes first)
#   - Package must already exist on npm with a trusted publisher configured.

set -euo pipefail

PACKAGE="${1:-}"
VERSION="${2:-}"

if [ -z "$PACKAGE" ]; then
  echo "Usage: make publish PACKAGE=<extension-name> [VERSION=<x.y.z>]" >&2
  echo "Known packages: pi-double-paste, pi-inline-skill-identifier, pi-openai-text-verbosity, pi-split-session, pi-tool-call-markers, pi-welcome-screen" >&2
  exit 1
fi

DIR="extensions/$PACKAGE"
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
git push origin main

gh release create "$TAG" \
  --target main \
  --title "$TAG" \
  --notes "Release $PKG_NAME@$NEW_VERSION" \
  --latest

echo ""
echo "Done. Release $TAG created."
echo "GitHub Actions will publish $PKG_NAME@$NEW_VERSION to npm via OIDC."
echo "Watch: gh run watch"
