# @vite-hub/email decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Email runtime details

`bytesToBase64`, `runtime`, `isEmailProviderError`, `outboxState`, `bundleEsmEntry`, `previewImport` in `packages/email/src/drivers/shared.ts`, `packages/email/src/operations.ts`, `packages/email/src/provider.ts`, `packages/email/src/runtime/outbox.ts`, `packages/email/src/vite.ts`.

**Context:** SharedArrayBuffer input, cold operations, cross-realm errors, two bundles in one runtime, nuxt prepare ordering.

**Decision:** Copy shared memory, chunk by multiples of 3; import the definition first; duck-type provider errors; outbox state on a Symbol.for global; tsconfig: false for template bundles; registry stays external.

**Consequences:** Each choice breaks a real host case if reverted.
