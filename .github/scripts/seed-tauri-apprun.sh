#!/usr/bin/env bash
# Tauri's AppImage bundler downloads AppRun into ~/.cache/tauri with mode 0770
# (write_and_make_executable). That file is copied into the AppDir and renamed
# to AppRun.wrapped; with owner root inside the squashfs, world cannot execute
# it (firejail / AppImageHub: Permission denied). Pre-seed the cache as 0755 so
# fs::copy keeps world-executable bits; Tauri skips the download when the file
# already exists.
set -euo pipefail

ARCH="${1:-x86_64}"
CACHE_DIR="${XDG_CACHE_HOME:-${HOME}/.cache}/tauri"
APPRUN="${CACHE_DIR}/AppRun-${ARCH}"
URL="https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-${ARCH}"

mkdir -p "$CACHE_DIR"

if [ ! -f "$APPRUN" ]; then
	echo "Downloading AppRun-${ARCH} into ${CACHE_DIR}…"
	curl -fsSL -o "$APPRUN" "$URL"
fi

chmod 755 "$APPRUN"
mode="$(stat -c '%a' "$APPRUN" 2>/dev/null || stat -f '%OLp' "$APPRUN")"
case "$mode" in
	755 | 775 | 777) echo "AppRun cache ready: ${APPRUN} (mode ${mode})" ;;
	*)
		echo "::error::expected world-executable AppRun cache, got mode ${mode} at ${APPRUN}"
		ls -la "$APPRUN" || true
		exit 1
		;;
esac
