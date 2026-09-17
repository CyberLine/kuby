#!/usr/bin/env bash
# Single writer for latest.json: list draft release assets, attach signatures,
# upload one file named latest.json. Platform jobs must not upload this file.
set -euo pipefail

TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "::error::Release ${TAG} does not exist; the create-draft job should have created it."
  exit 1
fi
if [ "$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)" != "true" ]; then
  echo "::error::Release ${TAG} is already published. Immutable releases cannot receive more assets. Tag a new version instead of reusing ${TAG}."
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
mkdir -p "$WORKDIR/sigs"

gh release view "$TAG" --repo "$REPO" --json assets,body,createdAt >"$WORKDIR/release.json"
gh release download "$TAG" --repo "$REPO" --pattern '*.sig' --dir "$WORKDIR/sigs"

echo "Generating latest.json from release assets…"
node "${SCRIPT_DIR}/generate-latest-json.mjs" \
  "$WORKDIR/release.json" \
  "$WORKDIR/sigs" \
  "$WORKDIR/latest.json"

if grep -q '/untagged-' "$WORKDIR/latest.json"; then
  echo "::error::latest.json still contains untagged- draft URLs"
  cat "$WORKDIR/latest.json"
  exit 1
fi

# Path basename is the asset name — never use file#label (that is a display label).
gh release upload "$TAG" --repo "$REPO" "$WORKDIR/latest.json" --clobber

names="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name')"
latest_count="$(printf '%s\n' "$names" | grep -cx 'latest.json' || true)"
if [ "$latest_count" -ne 1 ]; then
  echo "::error::expected exactly 1 asset named latest.json, found ${latest_count}"
  printf '%s\n' "$names"
  exit 1
fi
if printf '%s\n' "$names" | grep -E '^tmp\.'; then
  echo "::error::release still has leftover tmp.* assets from a broken latest.json upload"
  exit 1
fi

echo "Uploaded latest.json"
