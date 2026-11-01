# @vite-hub/codemods

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fcodemods&icon=npm)](https://npmx.dev/package/@vite-hub/codemods)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/codemods` moves an application to ViteHub. Each codemod edits the source files that it can change safely and ends with a report: the files it changed and a numbered list of manual follow-ups, with `file:line` where it applies.

The package requires Node 24 or newer.

## Run a codemod

```sh
npx @vite-hub/codemods nuxt-safe-runtime-config [dir] [--dry-run]
```

`dir` is the application directory. It defaults to the current directory. `--dry-run` prints the planned edits as diffs and the report, and writes nothing. Run the command with no arguments, or with `--help`, to list the codemods.

The command exits with `0` when the codemod completes, also when it reports follow-ups. It exits with `1` when it cannot migrate, for example when it cannot find or parse `nuxt.config`. The codemods do not install packages. The report prints the install command.

| Codemod | Moves |
| --- | --- |
| `nuxt-safe-runtime-config` | A Nuxt app from the `nuxt-safe-runtime-config` module to ViteHub Env through `vite-hub/nuxt` |

## `nuxt-safe-runtime-config`

The codemod reads one of the two schema sources of the module:

- `safeRuntimeConfig.envSchema` points at a `.env.example` with `@env-spec` annotations. The codemod replaces it with `envSchema(new URL("./.env.example", import.meta.url), { prefix: "NUXT_" })` from `@vite-hub/env/vite`. With the `NUXT_` prefix, `NUXT_PUBLIC_*` keys become Public Env and other `NUXT_*` keys become Server Env, with the same names and variables. Server `paths` stay the same. Public Env is flat, so a nested public path falls back to its flat name.
- `safeRuntimeConfig.$schema` is a Valibot, Zod, or ArkType schema, inline or in a module. The codemod converts it to JSON Schema and writes `env()`, `env.number()`, `env.boolean()`, and `env.enum()` declarations under `vitehub.env`. Each declaration reads its `NUXT_*` variable with `env.source()`. Literal `runtimeConfig` values, including empty strings, become defaults, and keys under `runtimeConfig.public` become Public Env with `mode: "build"`. Credential-like server names become `secret: true`.

In both cases the codemod replaces `'nuxt-safe-runtime-config'` with `'vite-hub/nuxt'` in `modules`, removes `safeRuntimeConfig` and the migrated `runtimeConfig` keys, sets `vitehub.preset`, and swaps the package in `package.json`. It rewrites `useSafeRuntimeConfig()` to `useServerEnv()` from `#vitehub/env/server` in server files and to `usePublicEnv()` from `#vitehub/env/public` in app files.

An existing `modules` property must be an array literal. If it is an expression such as `buildModules()`, or a root spread could supply an inherited list, the codemod stops without writing files; make the list explicit before retrying. A dynamic `nitro.preset` also stops the codemod unless a ViteHub preset is already explicit; use a string literal or set `vitehub.preset` before retrying. Consumed local layers inside the app are included in call-site migration. Local layers outside the app directory are left unchanged and named in the report for manual migration before using the migrated app.

The report lists what Env cannot express and what the codemod could not rewrite: constraints and transforms, unions, JSON arrays and objects, non-empty secret defaults that are omitted from the server build, secret reads that need `.unseal()`, reads that pass the config object on, `useRuntimeConfig()` reads of migrated keys, template reads, and ESLint rules of the module. Public Env values are fixed when you build, while Nuxt applied `NUXT_PUBLIC_*` overrides when the server started.

[`examples/nuxt-safe-runtime-config`](./examples/nuxt-safe-runtime-config) is a Nuxt app that uses the module. The end-to-end test builds and starts it, migrates a copy, type-checks and builds the copy with `vite-hub/nuxt`, and compares the typed values that one server route returns:

```sh
corepack pnpm exec vp run codemods:e2e
```

## Add a codemod

A codemod is a `Codemod` object with a `name`, a one-line `description`, and a `run()` function that returns planned edits and follow-ups. `run()` must not write files; the runner writes them, or prints them in a dry run. Add the codemod to `src/registry.ts`.

```ts
import { runCodemod, formatReport } from "@vite-hub/codemods"

const run = await runCodemod("nuxt-safe-runtime-config", { cwd: "./app", dryRun: true })
console.log(formatReport(run))
```
