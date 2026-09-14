# Distribution notes for Kuby

## macOS signing & notarization

1. Obtain an Apple Developer ID Application certificate.
2. Set env vars before `pnpm tauri build`:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
```

3. `tauri.conf.json` already sets `bundle.macOS.hardenedRuntime: true`.

## Linux packages

`bundle.targets` includes `appimage`, `deb`, and `rpm`. Build on Linux (or CI) with:

```bash
pnpm tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`.

## Versioning

Single source of truth: root `package.json` → `version`.

- `tauri.conf.json` points at that file (`"version": "../package.json"`).
- `src-tauri/Cargo.toml` is synced via `pnpm sync-version` (also runs in `beforeBuildCommand`).

Bump with e.g. `pnpm version patch` (or edit `package.json`), then `pnpm sync-version`.

## Auto-update

1. Generate keys: `pnpm tauri signer generate -w ~/.tauri/kuby.key`
2. Put the public key into `tauri.conf.json` → `plugins.updater.pubkey`
3. Set repo secrets `TAURI_SIGNING_PRIVATE_KEY` (+ optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
4. Releases upload `latest.json` + signed artifacts via the tag-triggered Release workflow
5. Frontend can call `@tauri-apps/plugin-updater` `check()` when ready

## GitHub Releases

Push a version tag that matches `package.json` (e.g. `v0.3.0`). Only `v*` tags run the Release workflow; `main` and other branches do not.

```bash
# after bumping package.json version
pnpm sync-version
git add -A && git commit -m "release: v0.3.0"
git tag v0.3.0
git push origin main --tags
```

Builds: macOS universal (`.dmg`) and Linux (`.AppImage`, `.deb`, `.rpm`).


## Performance

- Resource lists use a virtualized window (`VirtualList`) for thousands of objects
- Watch tasks are aborted on cluster disconnect / kind change
- Log streams are capped client-side (~5k lines)
