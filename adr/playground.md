# Playground decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format. The playground apps live in `playground/`.

## Log a failed translation enqueue after a committed save

`hooks["write:after"]` in `playground/content/server/workspaces/site.ts`.

**Context:** Workspace runs `write:after` hooks after the commit (`runHooks` in `packages/workspace/src/core/rules.ts`), and a hook that throws fails the save response although the file is saved. Workspace has no channel for an after-commit failure, and the Queue send is not part of the commit.

**Decision:** When `sendQueue("translate")` returns an error, log it with the page path and let the save succeed.

**Consequences:** A failed enqueue loses that translation until the page is saved again. When Workspace reports after-commit hook errors without failing the save, or the enqueue moves into the commit as an outbox, the hook returns or rethrows the error instead of logging it.

## Alias @cloudflare/sandbox to its ESM entry in the e2e build

`alias["@cloudflare/sandbox"]` in `prepareFeatureArtifacts` in `playground/vite/build/vite-e2e.ts`.

**Context:** `playground/vite` is not a workspace package, so the runtime files that the e2e build generates cannot resolve `@cloudflare/sandbox` themselves. The build resolves dependencies from the owning package with `createRequire().resolve()`, and `@cloudflare/sandbox` 1.0 exports only the `import` condition, which `require.resolve` cannot read ([cloudflare/sandbox-sdk#1053](https://github.com/cloudflare/sandbox-sdk/issues/1053), reported). `import.meta.resolve` takes a parent only behind `--experimental-import-meta-resolve`.

**Decision:** Alias `@cloudflare/sandbox` to `packages/sandbox/node_modules/@cloudflare/sandbox/dist/index.mjs`.

**Consequences:** A release that moves its entry breaks the e2e build. When sandbox-sdk#1053 ships, resolve it with `resolvePackageDependency(sandboxPackageDir, "@cloudflare/sandbox")` like the other dependencies.

## Strip provider output hooks from the e2e feature plugins

`withoutProviderOutput` in `playground/vite/build/vite-e2e.ts`, its calls in `playground/vite/vite.config.ts`.

**Context:** `createViteE2EComposer` writes the one hosted output of the e2e build. Each feature plugin writes its own provider output in `buildEnd` and `closeBundle`. Only Schedule has a `providerOutput` option, and with `false` its `closeBundle` still finalizes the provider output catalog. Queue, KV, Workflow, Database and Workspace have no such option.

**Decision:** Delete `buildEnd` and `closeBundle` from those plugins and keep their config, dev and CLI hooks.

**Consequences:** A feature plugin that moves output work into another hook writes a second output in the e2e build. When each plugin takes `providerOutput: false` and writes nothing with it, pass that option and delete `withoutProviderOutput`.
