# @vite-hub/kit decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## separate package from @vite-hub/ui; pixel tolerance 3

`exports test`, `color comparison` in `packages/kit/test/package.test.ts`, `packages/kit/test/browser/styles.browser.mjs`.

**Context:** @vite-hub/ui pulls heavy dependencies; CI Chromium anti-aliasing varies.

**Decision:** Keep kit free of ui dependencies; allow 3 levels per channel.

**Consequences:** Tokens are copied (see excuse); a real CSS change still fails.
