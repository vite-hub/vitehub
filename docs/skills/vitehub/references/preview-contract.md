# Installed and preview contracts

Use this for installation, upgrades, `pkg.pr.new`, missing imports, or dependency graphs that mix package generations.

## Released packages

For a fresh application, read [Installation](https://vitehub.dev/raw/docs/getting-started/installation.md), install `vite-hub`, inspect `node_modules/vite-hub/package.json`, and use the root `vitehub()` integration plus exported feature subpaths. Open [Import paths](https://vitehub.dev/raw/docs/reference/import-paths.md) only when an export is ambiguous or an existing import must migrate.

## Preview packages

Use an immutable full commit SHA. Probe the exact facade tarball before editing:

```bash
curl -I -L --fail "https://pkg.pr.new/vite-hub/vitehub/vite-hub@<full-sha>"
```

Install the facade as one coherent graph. Current pnpm versions reject preview tarballs whose dependencies are also tarball URLs unless exotic subdependencies are explicitly allowed:

```bash
PNPM_CONFIG_BLOCK_EXOTIC_SUBDEPS=false pnpm add "vite-hub@https://pkg.pr.new/vite-hub/vitehub/vite-hub@<full-sha>"
```

If the application intentionally needs direct owner packages, generate every selected URL from the same full SHA, probe each URL, and install them together. A split-commit graph is a canary-development exception; record why each split is required and prove it separately.

## Contract gate

1. Inspect the installed facade and owner-package `package.json` files, exports, and types.
2. Confirm every planned import exists in the installed graph.
3. Search the lockfile for `pkg.pr.new/vite-hub/vitehub` and verify resolved package names and commit keys match the intended graph.
4. Run the application build before assuming a `200` tarball is compatible.

The gate passes only when tarballs are available, the installed exports support the plan, the lockfile records the intended graph, and the smallest build succeeds.

## Drift rule

Never encode “latest” as a branch alias or copy a preview SHA from another project. Determine the requested commit, use its full SHA, and preserve it in the final report.
