# @vite-hub/kit decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## separate package from @vite-hub/ui; pixel tolerance 3

`exports test`, `color comparison` in `packages/kit/test/package.test.ts`, `packages/kit/test/browser/styles.browser.mjs`.

**Context:** @vite-hub/ui pulls heavy dependencies; CI Chromium anti-aliasing varies.

**Decision:** Keep kit free of ui dependencies; allow 3 levels per channel.

**Consequences:** Tokens are copied (see excuse); a real CSS change still fails.
## Keep the registry tokens in one source file

`buildRegistry` in `packages/kit/registry/registry.ts`.

**Context:** The published shadcn-vue registry serves style items as JSON, but the Kit also ships its tokens as CSS.

**Decision:** Generate registry `cssVars` from `packages/kit/src/styles/tokens.css` and commit the generated files under `docs/public/r/`. Regenerate with `pnpm --filter @vite-hub/kit build:registry` when registry inputs change.

**Consequences:** Registry installs and Kit builds use the same tokens, and tests detect stale generated files.
