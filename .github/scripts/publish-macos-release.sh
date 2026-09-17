#!/usr/bin/env bash
# After stapling Kuby.app: refresh updater tar.gz (+ .sig), then upload macOS
# assets to the draft GitHub Release. latest.json is generated later from the
# full asset list.
set -euo pipefail

BUNDLE_ROOT="${1:?usage: publish-macos-release.sh <bundle-root>}"
TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "::error::Release ${TAG} does not exist; the create-draft job should have created it."
  exit 1
fi
if [ "$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)" != "true" ]; then
  echo "::error::Release ${TAG} is already published. Immutable releases cannot receive more assets. Tag a new version instead of reusing ${TAG}."
  exit 1
fi

MACOS_DIR="${BUNDLE_ROOT}/macos"
DMG_DIR="${BUNDLE_ROOT}/dmg"
APP="${MACOS_DIR}/Kuby.app"
TAR="${MACOS_DIR}/Kuby.app.tar.gz"
SIG="${TAR}.sig"

: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required}"

if [ ! -d "$APP" ]; then
  echo "::error::missing app bundle at ${APP}"
  exit 1
fi

DMG="$(find "$DMG_DIR" -maxdepth 1 -name 'Kuby_*.dmg' -type f | head -1 || true)"
if [ -z "$DMG" ]; then
  echo "::error::no DMG found under ${DMG_DIR}"
  exit 1
fi

echo "Packaging updater archive from stapled app…"
rm -f "$TAR" "$SIG"
tar -czf "$TAR" -C "$MACOS_DIR" "Kuby.app"

echo "Signing updater archive…"
pnpm exec tauri signer sign "$TAR"
if [ ! -f "$SIG" ]; then
  echo "::error::expected signature at ${SIG}"
  exit 1
fi

echo "Uploading macOS assets to release ${TAG}…"
gh release upload "$TAG" "$DMG" "$TAR" "$SIG" --clobber

echo "macOS release assets published"
