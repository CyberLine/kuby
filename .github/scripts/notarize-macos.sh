#!/usr/bin/env bash
# Notarize + staple a macOS .app (and optional .dmg) with retries.
# Avoids `notarytool submit --wait`, which often dies on flaky uploads to Apple.
#
# Usage:
#   notarize-macos.sh --preflight
#   notarize-macos.sh <App.app> [optional.dmg]
set -euo pipefail

PREFLIGHT=0
if [ "${1:-}" = "--preflight" ]; then
  PREFLIGHT=1
  shift
fi

if [ "$PREFLIGHT" -eq 0 ]; then
  APP_PATH="${1:?usage: notarize-macos.sh [--preflight] <App.app> [optional.dmg]}"
  DMG_PATH="${2:-}"
fi

: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_PASSWORD:?APPLE_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

SUBMIT_ATTEMPTS="${NOTARY_SUBMIT_ATTEMPTS:-4}"
SUBMIT_TIMEOUT_SEC="${NOTARY_SUBMIT_TIMEOUT_SEC:-900}"
POLL_INTERVAL_SEC="${NOTARY_POLL_INTERVAL_SEC:-30}"
POLL_MAX_SEC="${NOTARY_POLL_MAX_SEC:-3600}"
POLL_TRANSIENT_FAILS="${NOTARY_POLL_TRANSIENT_FAILS:-5}"
PREFLIGHT_CONNECT_SEC="${NOTARY_PREFLIGHT_CONNECT_SEC:-8}"
PREFLIGHT_HTTP_SEC="${NOTARY_PREFLIGHT_HTTP_SEC:-15}"
PREFLIGHT_HISTORY_SEC="${NOTARY_PREFLIGHT_HISTORY_SEC:-30}"

AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")

# Hosts notarytool talks to. A GitHub-hosted runner that cannot reach these
# will hang for hours on submit — fail in seconds instead.
NOTARY_PROBE_URLS=(
  "https://appstoreconnect.apple.com"
  "https://appstoreconnect.apple.com/notary/v2/submissions"
)

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

probe_https() {
  local url="$1"
  local out=""
  local code=""
  echo "Probing ${url}…"
  out="$(
    curl -sS -o /dev/null \
      --connect-timeout "$PREFLIGHT_CONNECT_SEC" \
      --max-time "$PREFLIGHT_HTTP_SEC" \
      -w 'http=%{http_code} connect=%{time_connect}s total=%{time_total}s ip=%{remote_ip}' \
      "$url" || true
  )"
  echo "  ${out:-no response}"
  code="$(printf '%s' "$out" | sed -n 's/.*http=\([0-9][0-9][0-9]\).*/\1/p')"
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    echo "::error::Apple Notary host unreachable: ${url}. This runner got no HTTP response (timeout, DNS, TLS, or blocked). Aborting before upload."
    return 1
  fi
  return 0
}

preflight_apple_notary() {
  echo "::group::Apple Notary reachability"
  local url
  for url in "${NOTARY_PROBE_URLS[@]}"; do
    probe_https "$url"
  done

  echo "Authenticated notarytool ping (history, ${PREFLIGHT_HISTORY_SEC}s timeout)…"
  local tmp_out tmp_err
  tmp_out="$(mktemp)"
  tmp_err="$(mktemp)"
  if ! perl -e 'alarm shift; exec @ARGV' "$PREFLIGHT_HISTORY_SEC" \
    xcrun notarytool history "${AUTH[@]}" --output-format json \
    >"$tmp_out" 2>"$tmp_err"; then
    echo "::error::notarytool history failed or timed out after ${PREFLIGHT_HISTORY_SEC}s — Apple Notary API is unreachable or credentials are invalid."
    cat "$tmp_err" >&2 || true
    cat "$tmp_out" >&2 || true
    rm -f "$tmp_out" "$tmp_err"
    echo "::endgroup::"
    return 1
  fi
  rm -f "$tmp_out" "$tmp_err"
  echo "Apple Notary API reachable."
  echo "::endgroup::"
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

preflight_apple_notary

if [ "$PREFLIGHT" -eq 1 ]; then
  exit 0
fi

notarize_file "$APP_PATH" "$(basename "$APP_PATH")"
if [ -n "$DMG_PATH" ]; then
  notarize_file "$DMG_PATH" "$(basename "$DMG_PATH")"
fi

echo "notarization complete"
