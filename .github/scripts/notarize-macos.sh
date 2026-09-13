#!/usr/bin/env bash
# Notarize + staple a macOS .app (and optional .dmg) with retries.
# Avoids `notarytool submit --wait`, which often dies on flaky uploads to Apple.
set -euo pipefail

APP_PATH="${1:?usage: notarize-macos.sh <App.app> [optional.dmg]}"
DMG_PATH="${2:-}"

: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_PASSWORD:?APPLE_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

SUBMIT_ATTEMPTS="${NOTARY_SUBMIT_ATTEMPTS:-4}"
SUBMIT_TIMEOUT_SEC="${NOTARY_SUBMIT_TIMEOUT_SEC:-900}"
POLL_INTERVAL_SEC="${NOTARY_POLL_INTERVAL_SEC:-30}"
POLL_MAX_SEC="${NOTARY_POLL_MAX_SEC:-3600}"
POLL_TRANSIENT_FAILS="${NOTARY_POLL_TRANSIENT_FAILS:-5}"

AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")

json_field() {
  # usage: json_field <file> <key>
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const j = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const v = j?.[process.argv[2]];
    if (v == null) process.exit(2);
    process.stdout.write(String(v));
  ' "$1" "$2"
}

submit_with_retries() {
  local file="$1"
  local attempt=1
  local tmp_out=""
  local submission_id=""

  while [ "$attempt" -le "$SUBMIT_ATTEMPTS" ]; do
    echo "notarytool submit attempt ${attempt}/${SUBMIT_ATTEMPTS}: $(basename "$file")" >&2
    tmp_out="$(mktemp)"
    # Upload only (no --wait). Kill hung transfers after SUBMIT_TIMEOUT_SEC.
    # Progress stays on stderr (CI logs); JSON result on stdout.
    if perl -e 'alarm shift; exec @ARGV' "$SUBMIT_TIMEOUT_SEC" \
      xcrun notarytool submit "$file" "${AUTH[@]}" --output-format json \
      >"$tmp_out"; then
      if submission_id="$(json_field "$tmp_out" id)"; then
        rm -f "$tmp_out"
        echo "submission id: $submission_id" >&2
        printf '%s' "$submission_id"
        return 0
      fi
      echo "submit returned no id:" >&2
      cat "$tmp_out" >&2 || true
    else
      echo "submit failed or timed out after ${SUBMIT_TIMEOUT_SEC}s" >&2
      cat "$tmp_out" >&2 || true
    fi
    rm -f "$tmp_out"
    attempt=$((attempt + 1))
    if [ "$attempt" -le "$SUBMIT_ATTEMPTS" ]; then
      sleep $((attempt * 15))
    fi
  done
  return 1
}

wait_for_acceptance() {
  local submission_id="$1"
  local elapsed=0
  local fails=0
  local status=""
  local tmp_out=""

  while [ "$elapsed" -lt "$POLL_MAX_SEC" ]; do
    tmp_out="$(mktemp)"
    if xcrun notarytool info "$submission_id" "${AUTH[@]}" --output-format json >"$tmp_out" 2>&1; then
      fails=0
      status="$(json_field "$tmp_out" status || echo Unknown)"
      rm -f "$tmp_out"
      echo "[${elapsed}s] status=${status}"
      case "$status" in
        Accepted) return 0 ;;
        "In Progress") ;;
        Invalid|Rejected)
          echo "notarization ${status}; fetching log…" >&2
          xcrun notarytool log "$submission_id" "${AUTH[@]}" || true
          return 1
          ;;
        *)
          echo "unexpected status: ${status}" >&2
          return 1
          ;;
      esac
    else
      fails=$((fails + 1))
      echo "[${elapsed}s] notarytool info failed (${fails}/${POLL_TRANSIENT_FAILS}): $(cat "$tmp_out")" >&2
      rm -f "$tmp_out"
      if [ "$fails" -ge "$POLL_TRANSIENT_FAILS" ]; then
        return 1
      fi
    fi
    sleep "$POLL_INTERVAL_SEC"
    elapsed=$((elapsed + POLL_INTERVAL_SEC))
  done
  echo "timed out after ${POLL_MAX_SEC}s waiting for Apple" >&2
  return 1
}

notarize_file() {
  local file="$1"
  local label="$2"
  local zip=""
  local to_submit="$file"
  local submission_id=""

  echo "::group::Notarize ${label}"
  if [[ "$file" == *.app ]]; then
    zip="$(mktemp -t kuby-notarize).zip"
    ditto -c -k --keepParent "$file" "$zip"
    to_submit="$zip"
  fi

  submission_id="$(submit_with_retries "$to_submit")"
  wait_for_acceptance "$submission_id"
  xcrun stapler staple "$file"
  xcrun stapler validate "$file"
  if [ -n "$zip" ]; then
    rm -f "$zip"
  fi
  echo "::endgroup::"
}

notarize_file "$APP_PATH" "$(basename "$APP_PATH")"
if [ -n "$DMG_PATH" ]; then
  notarize_file "$DMG_PATH" "$(basename "$DMG_PATH")"
fi

echo "notarization complete"
