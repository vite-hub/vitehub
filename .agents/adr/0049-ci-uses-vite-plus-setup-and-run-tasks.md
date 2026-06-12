# CI Uses Vite+ Setup and Run Tasks

ViteHub CI uses Vite+ setup and installation instead of separate package-manager and Node setup actions. Repository workflows should invoke project-defined workflows through `vp run`, while built-in Vite+ commands such as `vp check` can replace existing checks only after their behavior is verified as equivalent for the monorepo.

## Considered Options

- Keeping CI on direct `pnpm` setup was rejected because Vite+ should own the development and build workflow after the migration.
- Replacing the root monorepo build with built-in `vp build` immediately was rejected because `vp build` is the Vite application build command, while ViteHub's root build coordinates package packing.

## Consequences

CI setup should use `voidzero-dev/setup-vp` with Node 24 and Vite+ dependency caching. Root CI commands should prefer `vp run verify` or explicit `vp run` task names until the built-in Vite+ check/build commands are proven to match ViteHub's package workflow.
