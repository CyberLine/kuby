#!/usr/bin/env bash
# After stapling Kuby.app: refresh updater tar.gz (+ .sig), then upload macOS
# assets to the GitHub Release and merge darwin platforms into latest.json.
set -euo pipefail

BUNDLE_ROOT="${1:?usage: publish-macos-release.sh <bundle-root>}"
TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
VERSION="${TAG#v}"
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

BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
TAR_NAME="$(basename "$TAR")"
SIG_BODY="$(tr -d '\n' <"$SIG")"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

TMP="$(mktemp)"
if gh release download "$TAG" --pattern latest.json --output "$TMP" 2>/dev/null; then
  echo "Merging darwin platforms into existing latest.json…"
else
  echo "Creating fresh latest.json…"
  printf '%s\n' "{\"version\":\"${VERSION}\",\"notes\":\"\",\"pub_date\":\"${PUB_DATE}\",\"platforms\":{}}" >"$TMP"
fi

node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[1];
const version = process.argv[2];
const pubDate = process.argv[3];
const url = process.argv[4];
const signature = process.argv[5];
const json = JSON.parse(readFileSync(path, 'utf8'));
json.version = version;
json.pub_date = json.pub_date || pubDate;
json.platforms = json.platforms || {};
const entry = { signature, url };
json.platforms['darwin-aarch64'] = entry;
json.platforms['darwin-x86_64'] = entry;
json.platforms['darwin-universal'] = entry;
writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
" "$TMP" "$VERSION" "$PUB_DATE" "${BASE_URL}/${TAR_NAME}" "$SIG_BODY"

gh release upload "$TAG" "$TMP#latest.json" --clobber
rm -f "$TMP"

echo "macOS release assets published"
