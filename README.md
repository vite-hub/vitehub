<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vite-hub/vitehub/main/docs/public/vitehub-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/vite-hub/vitehub/main/docs/public/vitehub-logo.png">
    <img alt="ViteHub" src="https://raw.githubusercontent.com/vite-hub/vitehub/main/docs/public/vitehub-logo.png" width="360">
  </picture>
</p>

<p align="center">
  Server primitives for any host.
</p>

<p align="center">
  <a href="https://vitehub.dev">Documentation</a>
</p>

## Workspace Rules

- Root scripts orchestrate package scripts. They do not define package test behavior.
- Packages own their own `src`, `test`, build, and typecheck flows.
- Root-level tests are opt-in and only for true workspace invariants.
- Package-local `examples/` stay manual fixtures outside the default pnpm workspace unless a task explicitly opts them in.
- `examples/` stays manual-only by default. It is not part of the default root `test`, `typecheck`, or `build` path.
- Package-local config files should only exist when a package has a real local need.
- External dependency versions are centralized in named pnpm catalogs by purpose.
- Local development uses Vite+ with Node 24.

## Commands

- `vp run test` runs `test` in `packages/*`
- `vp run typecheck` runs docs and package typechecks
- `vp run build` runs package `vp pack` builds
- `vp run lint` stays root-owned
- `vp run docs:dev` and `vp run docs:build` are explicit docs commands
- `vp run verify` runs lint, typecheck, contracts, tests, and build - the full local gate

## Package Baseline

Each package should be addable with:

- its own `package.json`
- its own `src`
- optional `test`
- optional `tsconfig`
- optional local tool config only when needed

Adding a package should not require editing a central root test harness.
