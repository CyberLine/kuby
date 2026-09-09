# Kuby

Native multi-cluster Kubernetes desktop client built with **Tauri 2**, **Rust (`kube-rs`)**, and **SolidJS**.

## Features

- Multi-cluster kubeconfig contexts (`KUBECONFIG` honored)
- Live resource watches via `kube_runtime::watcher`
- Generic API discovery + DynamicObject access (incl. CRDs)
- Curated views for ~30 core resource kinds
- Detail / YAML apply / logs / exec / port-forward
- Aggregated logs, global search, multi-namespace selector
- Side-by-side YAML diff + metrics.k8s.io CPU/RAM
- Auth summaries for OIDC/kubelogin, EKS/GKE/AKS exec plugins, client certs, Teleport
- Virtualized lists for large clusters
- Bundling targets: macOS app/dmg, Linux AppImage/deb/rpm + updater plugin

## Develop

```bash
pnpm install
pnpm tauri dev
```

Requires Rust stable, Node 22+/pnpm, and a valid `~/.kube/config` (or `KUBECONFIG`).

## Quality and security

Commit hooks (Lefthook) format staged files and scan for secrets. GitHub Actions run the same checks plus Clippy, tests, cargo-deny, OSV-Scanner, and knip.

```bash
pnpm install          # installs Lefthook hooks
brew install gitleaks # optional local secret scan (CI always runs it)
pnpm quality          # typecheck + Biome + knip
```

Dependabot opens weekly PRs for npm, Cargo, and GitHub Actions.

## Build

```bash
pnpm tauri build
```

### Distribution / signing (Phase 5)

- **macOS**: set `APPLE_SIGNING_IDENTITY` / notarization credentials; `tauri.conf.json` enables `hardenedRuntime`. Replace `bundle.macOS.signingIdentity` when ready.
- **Linux**: AppImage, deb, and rpm targets are enabled under `bundle.targets`.
- **Auto-update**: `tauri-plugin-updater` is wired. Generate a real minisign keypair (`tauri signer generate`) and replace `plugins.updater.pubkey` + release `endpoints`.

## Architecture

```
src-tauri/src/k8s/     ClusterManager, discovery, watch, exec, portforward, metrics, auth
src-tauri/src/commands/ Tauri IPC surface
src/stores/            Normalized Solid store + watch event application
src/components/        YAML (Monaco), logs, xterm exec, virtual list
```
