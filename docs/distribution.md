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

## Auto-update

1. Generate keys: `pnpm tauri signer generate -w ~/.tauri/kuby.key`
2. Put the public key into `tauri.conf.json` → `plugins.updater.pubkey`
3. Host `latest.json` (+ platform archives) at the configured `endpoints`
4. Frontend can call `@tauri-apps/plugin-updater` `check()` when ready

## Performance

- Resource lists use a virtualized window (`VirtualList`) for thousands of objects
- Watch tasks are aborted on cluster disconnect / kind change
- Log streams are capped client-side (~5k lines)
