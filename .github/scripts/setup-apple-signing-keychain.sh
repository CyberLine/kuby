#!/usr/bin/env bash
# Import Developer ID cert into a temporary keychain usable by headless codesign.
# Avoids errSecInternalComponent on self-hosted macOS runners (Tauri's own
# temp keychain import often lacks -A / partition-list for non-interactive use).
set -euo pipefail

if [ -z "${APPLE_CERTIFICATE:-}" ] || [ -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
  echo "APPLE_CERTIFICATE not set — skipping signing keychain setup"
  exit 0
fi

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"

KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-$(openssl rand -base64 32)}"
CERTIFICATE_PATH="${RUNNER_TEMP}/build_certificate.p12"
KEYCHAIN_PATH="${RUNNER_TEMP}/app-signing.keychain-db"

echo -n "$APPLE_CERTIFICATE" | base64 --decode >"$CERTIFICATE_PATH"

security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

security import "$CERTIFICATE_PATH" \
  -P "$APPLE_CERTIFICATE_PASSWORD" \
  -A \
  -t cert \
  -f pkcs12 \
  -k "$KEYCHAIN_PATH"

security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$KEYCHAIN_PASSWORD" \
  "$KEYCHAIN_PATH"

# Put our keychain first so codesign finds the imported identity.
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN_PATH" $(security list-keychains -d user | sed 's/"//g')

IDENTITY="$(
  security find-identity -v -p codesigning "$KEYCHAIN_PATH" \
    | awk -F'"' '/Developer ID Application/ { print $2; exit }'
)"

if [ -z "$IDENTITY" ]; then
  echo "::error::No Developer ID Application identity found after certificate import"
  security find-identity -v -p codesigning "$KEYCHAIN_PATH" || true
  exit 1
fi

echo "Using signing identity: $IDENTITY"
{
  echo "APPLE_SIGNING_IDENTITY=$IDENTITY"
  echo "APPLE_KEYCHAIN_PATH=$KEYCHAIN_PATH"
} >>"$GITHUB_ENV"
