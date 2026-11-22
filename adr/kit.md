# @vite-hub/kit decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## separate package from @vite-hub/ui; pixel tolerance 3

`exports test`, `color comparison` in `packages/kit/test/package.test.ts`, `packages/kit/test/browser/styles.browser.mjs`.

**Context:** @vite-hub/ui pulls heavy dependencies; CI Chromium anti-aliasing varies.

**Decision:** Keep kit free of ui dependencies; allow 3 levels per channel.

**Consequences:** Tokens are copied (see "Copy the theme tokens and test them equal"); a real CSS change still fails.

## Keep the registry tokens in one source file

`buildRegistry` in `packages/kit/registry/registry.ts`.

**Context:** The published shadcn-vue registry serves style items as JSON, but the Kit also ships its tokens as CSS.

**Decision:** Generate registry `cssVars` from `packages/kit/src/styles/tokens.css` and commit the generated files under `docs/public/r/`. Regenerate with `pnpm --filter @vite-hub/kit build:registry` when registry inputs change.

**Consequences:** Registry installs and Kit builds use the same tokens, and tests detect stale generated files.

## Inline the patched web.css into the published style family

`inlineWebCss` in `packages/kit/scripts/styles.ts`.

**Context:** The workspace patches `@ui-sdk/core@0.1.0-beta.5` through `patches/@ui-sdk__core@0.1.0-beta.5.patch`. Its `dist/web.css` hunk adds `[data-slot="visually-hidden"]`, the `--ui-ring-width` and `--ui-ring-offset` focus ring variables, and inline-flex icon slots. An app that installs the kit gets the unpatched `web.css` from npm, so an `@import` of it would lose these rules.

**Decision:** The build replaces the `@import "@ui-sdk/core/web.css"` in `default.css` with the patched file, and throws when the import is missing.

**Consequences:** Upgrading `@ui-sdk/core` means rebasing the patch and rebuilding the kit. When vercel-labs/ui ships these rules, drop the `web.css` hunk and `inlineWebCss`, and publish the `@import` again.

## Read selector nodes through a structural type

`SelectorPart` and `parseSelectors` in `packages/kit/scripts/styles.ts`.

**Context:** postcss-selector-parser 7.1 types `Selector` through `Container` and `Diff` types that refer to each other. The package typecheck compiler, tsrs 0.20.0 (TypeScript 7.1 beta), stops on any use of `Selector["nodes"]` with TS5115 ("Instantiations of the following types appear infinitely circular: 'Container', 'Diff'"). tsc 6.0.3 accepts the same code.

**Decision:** `parseSelectors` casts the parsed nodes to `SelectorPart`, which lists only the fields `styles.ts` and `test/package.test.ts` read.

**Consequences:** A new field read from a node must be added to `SelectorPart`. When tsrs or postcss-selector-parser fixes the circular instantiation, use the parser's `Selector` type and delete `SelectorPart`.

## Publish a scoped copy of the style family while the Console renders Nuxt UI

`./styles/default.scoped.css` in `packages/kit/package.json`, `scopeStyles` in `packages/kit/scripts/styles.ts`, `exports test` in `packages/kit/test/package.test.ts`.

**Context:** The Console (`packages/vite-hub/src/console/runtime/client/styles.css`) still renders Nuxt UI, and the unscoped style family restyles its elements.

**Decision:** The build also writes `default.scoped.css`, every rule under `:where(.ui-sdk)`, and the kit publishes it as a seventh export.

**Consequences:** When the Console has no Nuxt UI left, it imports `default.css`, and the scoped export, `scopeStyles`, its build step and its tests go.

## Copy the theme tokens and test them equal

`packages/kit/src/styles/tokens.css`, `packages/kit/test/tokens.test.ts`.

**Context:** The Console and the docs read their tokens from `@vite-hub/ui/theme.css`, which names Nuxt UI variables and Tailwind palette steps. The kit must not depend on `@vite-hub/ui` (see the first entry), and it ships plain values with its own names.

**Decision:** `tokens.css` holds the values of `theme.css` under the kit names, and `tokens.test.ts` fails when the two disagree.

**Consequences:** A token change edits both files. When the Console and the docs read the kit tokens, `theme.css` drops its copy and the test goes.

## Type the Nuxt module with a method signature

`KitNuxtModule` in `packages/kit/src/nuxt.ts`.

**Context:** The kit builds against `@nuxt/kit` 4.6.2 and `@nuxt/schema` 4.6.4, the versions that `@vite-hub/ui` and `@vite-hub/docs` pin too, so `defineNuxtModule` returns a module that takes Nuxt 4's instance. An app on Nuxt 5 checks `[kit, options]` in `modules` against Nuxt 5's `NuxtModule`, whose instance type differs. A call signature with `nuxt: never`, as in `@vite-hub/ui`, fails that check in `test/nuxt.test-d.ts`.

**Decision:** Declare the module through a method signature, whose parameters TypeScript checks bivariantly, so the module fits both instance types. The peer range is Nuxt 5 only.

**Consequences:** When the workspace builds against Nuxt 5's `@nuxt/kit` and `@nuxt/schema`, type the module as `NuxtModule<KitNuxtOptions>` and delete `KitNuxtModule`.
