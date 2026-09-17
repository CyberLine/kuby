#!/usr/bin/env bash
# After the Windows tauri-action build: upload NSIS + updater assets to the
# draft GitHub Release. latest.json is generated later from the full asset list.
set -euo pipefail

BUNDLE_ROOT="${1:?usage: publish-windows-release.sh <bundle-root>}"
TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

NSIS_DIR="${BUNDLE_ROOT}/nsis"

: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required}"

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "::error::Release ${TAG} does not exist; the create-draft job should have created it."
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
attempts="${RELEASE_UPLOAD_ATTEMPTS:-3}"
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  if gh release upload "$TAG" --repo "$REPO" "${UPLOAD_ARGS[@]}" --clobber; then
    echo "Windows release assets published"
    exit 0
  fi
  echo "gh release upload failed (attempt ${attempt}/${attempts})"
  if [ "$attempt" -eq "$attempts" ]; then
    echo "::error::gh release upload failed after ${attempts} attempts"
    exit 1
  fi
  sleep $((attempt * 15))
  attempt=$((attempt + 1))
done
