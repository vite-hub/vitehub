# @vite-hub/codemods

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fcodemods&icon=npm)](https://npmx.dev/package/@vite-hub/codemods)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/codemods` moves an application to ViteHub. Each codemod edits the source files that it can change safely and ends with a report: the files it changed and a numbered list of manual follow-ups, with `file:line` where it applies.

The package requires Node.js 22.18 or newer.

## Migrate an app

```sh
npx @vite-hub/codemods [dir] [--dry-run]
```

The command finds every module in the app that a codemod supports and runs those codemods one after another, so each one sees the edits of the ones before it. `dir` is the application directory. It defaults to the current directory. `--dry-run` prints the combined edits as diffs and the report, and writes nothing.

The report lists, for each codemod, why it ran and what it did, then the files it changed, a numbered list of manual follow-ups with `file:line`, notes, and the commands to run next. A codemod that cannot migrate the app changes nothing and says why; the others still run. The report also warns when `package.json` requires a Nuxt version before 5, because ViteHub supports Nuxt 5 and Nitro 3 only. The codemods do not upgrade Nuxt or install packages. Nuxt 5 also stops auto-importing Nitro helpers such as `defineEventHandler` in server code. Set `experimental: { nitroAutoImports: true }` to keep them, or import them as the Nuxt 5 build error lists.

The migration uses a unique scratch directory and preserves existing `.vitehub-migrate` directories. If a codemod would edit a symbolic link or a file inside a linked directory, it stops without applying that codemod's edits. Replace the link with a local file or directory before retrying.

The command exits with `0` when every codemod completes, also when they report follow-ups. It exits with `1` when a codemod could not migrate, or when the app has no `nuxt.config`.

## Run one codemod

```sh
npx @vite-hub/codemods nuxt-safe-runtime-config [dir] [--dry-run]
```

The command runs only the named codemod. Run it with `--help` to list the codemods. It exits with `1` when the codemod cannot migrate, for example when it cannot find or parse `nuxt.config`.

| Codemod | Moves |
| --- | --- |
| `nuxt-safe-runtime-config` | A Nuxt app from the `nuxt-safe-runtime-config` module to ViteHub Env through `vite-hub/nuxt` |
| `t3-env` | A Nuxt app from `@t3-oss/env-nuxt` `createEnv()` to ViteHub Env through `vite-hub/nuxt` |
| `resend` | `nuxt-resend` and Resend SDK `emails.send()` calls to ViteHub Email through `vite-hub/nuxt` |

## `nuxt-safe-runtime-config`

The codemod reads one of the two schema sources of the module:

- `safeRuntimeConfig.envSchema` points at a `.env.example` with `@env-spec` annotations. The codemod replaces it with `envSchema(new URL("./.env.example", import.meta.url), { prefix: "NUXT_" })` from `@vite-hub/env/vite`. With the `NUXT_` prefix, `NUXT_PUBLIC_*` keys become Public Env and other `NUXT_*` keys become Server Env, with the same names and variables. Server `paths` stay the same. Public Env is flat, so a nested public path falls back to its flat name.
- `safeRuntimeConfig.$schema` is a Valibot, Zod 3, Zod 4, or ArkType schema, inline or in a module. For Zod 4 before 4.2, the codemod calls `toJSONSchema()` from the app's own Zod. The codemod converts it to JSON Schema and writes `env()`, `env.number()`, `env.boolean()`, and `env.enum()` declarations under `vitehub.env`. Each declaration reads its `NUXT_*` variable with `env.source()`. A `process.env.NAME || fallback` value reads `NAME` with a source that skips empty values, as `||` did, and keeps `fallback` as the default. Literal `runtimeConfig` values, including empty strings, become defaults, and keys under `runtimeConfig.public` become Public Env with `mode: "build"`. Credential-like server names become `secret: true`.

When `safeRuntimeConfig` declares neither, the module validates nothing, so the codemod removes it from `modules`, `nuxt.config`, and `package.json`. It stops instead when code still calls `useSafeRuntimeConfig()`.

In both cases the codemod replaces `'nuxt-safe-runtime-config'` with `'vite-hub/nuxt'` in `modules`, removes `safeRuntimeConfig` and the migrated `runtimeConfig` keys, sets `vitehub.preset`, and swaps the package in `package.json`. It rewrites `useSafeRuntimeConfig()` to `useServerEnv()` from `#vitehub/env/server` in server files and to `usePublicEnv()` from `#vitehub/env/public` in app files.

An existing `modules` property must be an array literal. If it is an expression such as `buildModules()`, or a root spread could supply an inherited list, the codemod stops without writing files; make the list explicit before retrying. A dynamic `nitro.preset` also stops the codemod unless a ViteHub preset is already explicit; use a string literal or set `vitehub.preset` before retrying. Consumed local layers inside the app are included in call-site migration. Local layers outside the app directory are left unchanged and named in the report for manual migration before using the migrated app.

The report lists what Env cannot express and what the codemod could not rewrite: constraints and transforms, unions, JSON arrays and objects, non-empty secret defaults that are omitted from the server build, secret reads that need `.unseal()`, reads that pass the config object on, `useRuntimeConfig()` reads of migrated keys, template reads, and ESLint rules of the module. Public Env values are fixed when you build, while Nuxt applied `NUXT_PUBLIC_*` overrides when the server started.

[`examples/nuxt-safe-runtime-config`](./examples/nuxt-safe-runtime-config) is a Nuxt app that uses the module. The end-to-end test builds and starts it, migrates a copy, type-checks and builds the copy with `vite-hub/nuxt`, and compares the typed values that one server route returns:

```sh
corepack pnpm exec vp run codemods:e2e
```

## `t3-env`

The codemod finds the file that calls `createEnv()` from `@t3-oss/env-nuxt`, loads its Valibot, Zod 3, Zod 4, or ArkType schemas without validating the current environment, and declares one value per variable under `vitehub.env`. Each declaration reads the original variable with `env.source()`. `DATABASE_URL` becomes `useServerEnv().databaseUrl`, and `NUXT_PUBLIC_SITE_URL` becomes `usePublicEnv().siteUrl`. Credential-like server names become `secret: true`.

It rewrites `env.KEY` reads in files that import the env module, through relative paths or the `~`, `~~`, `@`, `@@`, `#shared`, and `#server` aliases. Server reads become `useServerEnv().key`, with `.unseal()` on required secrets and `?.unseal()` on optional secrets so the code keeps the raw string or `undefined`, and public reads become `usePublicEnv().key`. It removes the `import './env'` that validated the env module from `nuxt.config`.

When no file imports the env module after the rewrite, the codemod deletes it and removes `@t3-oss/env-nuxt`. A file that runs outside Nuxt, such as `drizzle.config.ts`, keeps both, and the report names it. The report also lists what Env does not keep: formats, lengths, patterns, transforms, unions, server reads in browser code, template reads, and `createEnv()` options such as `skipValidation`.

The migration copies the schema's value shape. Parser behavior needs manual review. The report always asks you to check every migrated variable with missing and invalid values. Coercion, catch fallbacks, refinements, and transforms need manual review, including wrappers that the codemod does not recognize. For example, `z.coerce.boolean()` turns `"false"` into `true`, while `env.boolean()` returns `false`; schema `catch()` fallbacks on invalid values are not kept. Keep equivalent parsing and fallback handling where code reads the value.

## `resend`

The codemod rewrites `emails.send()` on `useResend()` clients of `nuxt-resend` and on `new Resend()` clients in server code to `email.send()` from `vite-hub/email/server`. It renames `reply_to` to `replyTo` and turns `const { data, error } = await ...send()` into `const [error, data] = await email.send()`. It replaces `nuxt-resend` with `vite-hub/nuxt` and sets `vitehub.email` to the Resend driver. The API key is Secret Env read from `NUXT_RESEND_API_KEY`, or from the variables that `runtimeConfig.resend.apiKey` and `new Resend()` read.

Code that checks `runtimeConfig.resend.apiKey` keeps working: the codemod preserves existing runtime config and declares the module's key when it removes `nuxt-resend`, even when it cannot detect readers. Dynamic runtime config needs a manual declaration. Credential inference follows global Env reads and proven runtime-config bindings; unknown sources need manual migration. `nuxt-resend` stays while a `useResend()` call is left that the codemod does not rewrite, such as a class field, and the `resend` package stays while code uses `batch`, contacts, audiences, or CommonJS imports. The report lists literal or dynamic API keys to move to Env, clients with different credential sources, `react` payloads, fields outside the portable Email message, and results that code reads in another shape. All migrated sends share one Email credential. Check that the sources refer to the same account; keep clients with different credentials on the SDK or configure them separately by hand. In `vite dev`, Email keeps messages in the development outbox unless `vitehub.email.remote` is `true`.

## Check real apps

`test/real-world/projects.json` pins open source Nuxt apps that use the supported modules. The runner clones each app outside the repository, installs it when its codemod loads app code, runs the migration, and checks which codemods ran and what the report says:

```sh
corepack pnpm exec vp run -t @vite-hub/codemods#build
node packages/codemods/test/real-world/run.mjs [--build] [id...]
```

With `--build`, it also moves each app that has a `build` entry to Nuxt 5 nightly with the local `vite-hub` checkout, builds it, starts the server, and checks the probes. Set `VITEHUB_REAL_WORLD_DIR` to choose where the apps go.

## Add a codemod

A codemod is a `Codemod` object with a `name`, a one-line `description`, a `detect()` function that tells whether the app uses what it migrates, and a `run()` function that returns planned edits and follow-ups. `run()` must not write files; the runner writes them, or prints them in a dry run. Add the codemod to `src/registry.ts`; the order there is the order in which the migration runs codemods. Shared `nuxt.config` and `package.json` helpers live in `src/shared`.

```ts
import { runCodemod, formatReport } from "@vite-hub/codemods"

const run = await runCodemod("nuxt-safe-runtime-config", { cwd: "./app", dryRun: true })
console.log(formatReport(run))
```
