# ViteHub

Server primitives for Vite, with a workspace shaped around package-owned development and verification.

## Workspace Rules

- Root scripts orchestrate package scripts. They do not define package test behavior.
- Packages own their own `src`, `test`, build, and typecheck flows.
- Root-level tests are opt-in and only for true workspace invariants.
- Package-local `examples/` are part of the pnpm workspace for installs and `workspace:*` linking.
- `examples/` stays manual-only by default. It is not part of the default root `test`, `typecheck`, or `build` path.
- Package-local config files should only exist when a package has a real local need.
- External dependency versions are centralized in named pnpm catalogs by purpose.

## Commands

- `pnpm test` runs `test` in `packages/*`
- `pnpm typecheck` runs `typecheck` in `packages/*`
- `pnpm build` runs `build` in `packages/*`
- `pnpm lint` stays root-owned
- `pnpm dev:docs` and `pnpm build:docs` are explicit docs commands

## Package Baseline

Each package should be addable with:

- its own `package.json`
- its own `src`
- optional `test`
- optional `tsconfig`
- optional local tool config only when needed

Adding a package should not require editing a central root test harness.
