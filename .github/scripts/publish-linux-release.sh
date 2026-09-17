#!/usr/bin/env bash
# After the Linux tauri-action build: chmod the AppImage, refresh updater
# tar.gz (+ .sig), then upload Linux assets. latest.json is generated later.
set -euo pipefail

BUNDLE_ROOT="${1:?usage: publish-linux-release.sh <bundle-root>}"
TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

APPIMAGE_DIR="${BUNDLE_ROOT}/appimage"
DEB_DIR="${BUNDLE_ROOT}/deb"
RPM_DIR="${BUNDLE_ROOT}/rpm"

: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required}"

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
	echo "::error::Release ${TAG} does not exist; the create-draft job should have created it."
	exit 1
fi

APPIMAGE="$(find "$APPIMAGE_DIR" -maxdepth 1 -name '*.AppImage' -type f | head -1 || true)"
DEB="$(find "$DEB_DIR" -maxdepth 1 -name '*.deb' -type f | head -1 || true)"
RPM="$(find "$RPM_DIR" -maxdepth 1 -name '*.rpm' -type f | head -1 || true)"

if [ -z "$APPIMAGE" ] || [ -z "$DEB" ] || [ -z "$RPM" ]; then
	echo "::error::missing Linux bundles (AppImage=${APPIMAGE:-none} deb=${DEB:-none} rpm=${RPM:-none})"
	find "$BUNDLE_ROOT" -maxdepth 3 -print || true
	exit 1
fi

# GitHub Actions artifact zip/download strips the execute bit. The updater
# extracts AppImage.tar.gz via tar unpack, so a 644 file inside will not start.
echo "Restoring execute bit on $(basename "$APPIMAGE")…"
chmod 755 "$APPIMAGE"
if [ ! -x "$APPIMAGE" ]; then
	echo "::error::${APPIMAGE} is not executable after chmod"
	ls -la "$APPIMAGE_DIR" || true
	exit 1
fi

TAR="${APPIMAGE}.tar.gz"
SIG="${TAR}.sig"
echo "Packaging updater archive from executable AppImage…"
rm -f "$TAR" "$SIG"
tar -czf "$TAR" -C "$(dirname "$APPIMAGE")" "$(basename "$APPIMAGE")"

bin_mode="$(tar -tzvf "$TAR" | awk '/\.AppImage$/ { print $1; exit }')"
case "$bin_mode" in
	-rwx*) echo "updater archive AppImage mode: ${bin_mode}" ;;
	*)
		echo "::error::updater archive lost execute bit on AppImage (mode=${bin_mode:-missing})"
		tar -tzvf "$TAR" || true
		exit 1
		;;
esac

echo "Signing updater archive…"
pnpm exec tauri signer sign "$TAR"
if [ ! -f "$SIG" ]; then
	echo "::error::expected signature at ${SIG}"
	exit 1
fi

APPIMAGE_SIG="${APPIMAGE}.sig"
DEB_SIG="${DEB}.sig"
RPM_SIG="${RPM}.sig"
for sig in "$APPIMAGE_SIG" "$DEB_SIG" "$RPM_SIG"; do
	if [ ! -f "$sig" ]; then
		echo "::error::missing signature ${sig}"
		exit 1
	fi
done

UPLOAD_ARGS=("$APPIMAGE" "$APPIMAGE_SIG" "$TAR" "$SIG" "$DEB" "$DEB_SIG" "$RPM" "$RPM_SIG")

echo "Uploading Linux assets to release ${TAG}…"
attempts="${RELEASE_UPLOAD_ATTEMPTS:-3}"
attempt=1
while [ "$attempt" -le "$attempts" ]; do
	if gh release upload "$TAG" --repo "$REPO" "${UPLOAD_ARGS[@]}" --clobber; then
		echo "Linux release assets published"
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
