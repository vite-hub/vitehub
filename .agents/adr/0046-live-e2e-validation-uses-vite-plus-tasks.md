# Live E2E Validation Uses Vite+ Tasks

Live provider E2E validation is exposed through explicit Vite+ tasks rather than package-local `test:e2e` scripts. Package `test` scripts stay focused on local Vitest checks, while deployed app validation remains an opt-in workflow that can accept provider URLs, credentials, and runtime flags.

## Considered Options

- Keeping `test:e2e` package scripts was rejected because the live checks are deployment validation workflows rather than ordinary package tests.
- Keeping `tsx` only for live E2E runners was rejected because the Node 24 and Vite+ migration should remove TypeScript script-runner dependencies from the default toolchain.

## Consequences

Live E2E runners should be plain runnable Node scripts or pack-built task entries. User-facing error text and documentation should point to `vp run` task names instead of `pnpm --dir packages/* test:e2e`.
