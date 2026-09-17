#!/usr/bin/env bash
# After the Windows tauri-action build: ensure NSIS + updater assets are on the
# GitHub Release and merge windows-x86_64 into latest.json (without wiping
# linux/darwin platforms written by other jobs).
set -euo pipefail

BUNDLE_ROOT="${1:?usage: publish-windows-release.sh <bundle-root>}"
TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
VERSION="${TAG#v}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

NSIS_DIR="${BUNDLE_ROOT}/nsis"

: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required}"

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "::error::Release ${TAG} does not exist; the create-draft job should have created it."
  exit 1
fi
if [ "$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)" != "true" ]; then
  echo "::error::Release ${TAG} is already published. Immutable releases cannot receive more assets. Tag a new version instead of reusing ${TAG}."
  exit 1
fi

if [ ! -d "$NSIS_DIR" ]; then
  echo "::error::missing NSIS bundle dir at ${NSIS_DIR}"
  find "$BUNDLE_ROOT" -maxdepth 3 -print || true
  exit 1
fi

SETUP="$(find "$NSIS_DIR" -maxdepth 1 -name '*-setup.exe' -type f | head -1 || true)"
if [ -z "$SETUP" ]; then
  echo "::error::no NSIS setup.exe found under ${NSIS_DIR}"
  ls -lah "$NSIS_DIR" || true
  exit 1
fi

# Prefer the updater zip Tauri emits next to the installer; fall back to .exe.
UPDATER="$(find "$NSIS_DIR" -maxdepth 1 -name '*.nsis.zip' -type f | head -1 || true)"
if [ -z "$UPDATER" ]; then
  UPDATER="$SETUP"
fi

SIG="${UPDATER}.sig"
if [ ! -f "$SIG" ]; then
  echo "Signing updater artifact $(basename "$UPDATER")…"
  pnpm exec tauri signer sign "$UPDATER"
fi
if [ ! -f "$SIG" ]; then
  echo "::error::expected signature at ${SIG}"
  exit 1
fi

UPLOAD_ARGS=("$SETUP")
if [ "$UPDATER" != "$SETUP" ]; then
  UPLOAD_ARGS+=("$UPDATER")
fi
UPLOAD_ARGS+=("$SIG")

echo "Uploading Windows assets to release ${TAG}…"
gh release upload "$TAG" "${UPLOAD_ARGS[@]}" --clobber

BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
UPDATER_NAME="$(basename "$UPDATER")"
SIG_BODY="$(tr -d '\n' <"$SIG")"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

TMP="$(mktemp)"
if gh release download "$TAG" --pattern latest.json --output "$TMP" 2>/dev/null; then
  echo "Merging windows-x86_64 into existing latest.json…"
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
json.platforms['windows-x86_64'] = { signature, url };
writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
" "$TMP" "$VERSION" "$PUB_DATE" "${BASE_URL}/${UPDATER_NAME}" "$SIG_BODY"

gh release upload "$TAG" "$TMP#latest.json" --clobber
rm -f "$TMP"

echo "Windows release assets published"
