---
title: Move from a Nuxt module
description: The codemods that move a Nuxt app from nuxt-safe-runtime-config, @t3-oss/env-nuxt, nuxt-resend, and nuxt-cron to ViteHub through vite-hub/nuxt.
navigation.title: Move from a Nuxt module
navigation.order: 4
icon: i-lucide-package
---

These codemods move a Nuxt app from a community module to the ViteHub feature that does the same work, through `vite-hub/nuxt`. `npx @vite-hub/codemods` detects the modules that the app uses. To run one codemod, pass its name:

```bash [Terminal]
npx @vite-hub/codemods nuxt-safe-runtime-config [dir] [--dry-run]
```

ViteHub supports Nuxt 5 only. The codemods do not upgrade Nuxt. The report warns when `package.json` requires an older version.

## nuxt-safe-runtime-config

The codemod moves the `nuxt-safe-runtime-config` module to ViteHub [Env](/docs/env). It reads one of the two schema sources of the module:

- `safeRuntimeConfig.envSchema` points at a `.env.example` with `@env-spec` annotations. The codemod replaces it with `envSchema(new URL("./.env.example", import.meta.url), { prefix: "NUXT_" })` from `@vite-hub/env/vite`. With the `NUXT_` prefix, `NUXT_PUBLIC_*` keys become Public Env, and other `NUXT_*` keys become Server Env, with the same names and variables. See [Import an environment schema](/docs/env/configure#import-an-environment-schema).
- `safeRuntimeConfig.$schema` is a Valibot, Zod 3, Zod 4, or ArkType schema, inline or in a module. The codemod converts it to JSON Schema and writes `env()`, `env.number()`, `env.boolean()`, and `env.enum()` declarations under `vitehub.env`. Each declaration reads its `NUXT_*` variable with `env.source()`. Literal `runtimeConfig` values become defaults, and keys under `runtimeConfig.public` become Public Env with `mode: "build"`. Credential-like server names become `secret: true`.

In both cases, the codemod replaces `'nuxt-safe-runtime-config'` with `'vite-hub/nuxt'` in `modules`, removes `safeRuntimeConfig` and the migrated `runtimeConfig` keys, sets `vitehub.host`, and swaps the package in `package.json`. It rewrites `useSafeRuntimeConfig()` to `useServerEnv()` from `#vitehub/env/server` in server files, and to `usePublicEnv()` from `#vitehub/env/public` in app files.

When `safeRuntimeConfig` declares no schema and the app has no layers, the module validates nothing. The codemod then removes the module, unless code still calls `useSafeRuntimeConfig()`.

The codemod stops without writing files when:

- `modules` is an expression, such as `buildModules()`, or a root spread can supply it. Make the list explicit.
- `nitro.preset` is dynamic and no ViteHub host is explicit. Use a string literal, or set `vitehub.host`.
- the config has no schema and extends layers, uses a root spread, or has automatic `layers/` directories.

The report lists what Env cannot express and what the codemod could not rewrite: constraints and transforms, unions, JSON arrays and objects, non-empty secret defaults, secret reads that need `.unseal()`, `useRuntimeConfig()` reads of migrated keys, template reads, and the ESLint rules of the module. Public Env values are fixed when you build, while Nuxt applied `NUXT_PUBLIC_*` overrides when the server started.

## t3-env

The codemod moves `createEnv()` from `@t3-oss/env-nuxt` to ViteHub [Env](/docs/env). It loads the Valibot, Zod 3, Zod 4, or ArkType schemas without validating the current environment, and declares one value for each variable under `vitehub.env`. Each declaration reads the original variable with `env.source()`. `DATABASE_URL` becomes `useServerEnv().databaseUrl`, and `NUXT_PUBLIC_SITE_URL` becomes `usePublicEnv().siteUrl`. Credential-like server names become `secret: true`.

It rewrites `env.KEY` reads in the files that import the env module, through relative paths or the `~`, `~~`, `@`, `@@`, `#shared`, and `#server` aliases:

- Server reads become `useServerEnv().key`, with `.unseal()` on required secrets and `?.unseal()` on optional secrets, so the code keeps the raw string or `undefined`.
- Public reads become `usePublicEnv().key`.

When no file imports the env module after the rewrite, the codemod deletes it and removes `@t3-oss/env-nuxt`. A file that runs outside Nuxt, such as `drizzle.config.ts`, keeps both, and the report names it.

The migration copies the value shape of the schema, not its parser. The report asks you to check every migrated variable with missing and invalid values. Coercion, `catch()` fallbacks, refinements, and transforms need a manual review. For example, `z.coerce.boolean()` turns `"false"` into `true`, while `env.boolean()` returns `false`.

## resend

The codemod moves `emails.send()` calls to ViteHub [Email](/docs/email). It rewrites the calls on `useResend()` clients of `nuxt-resend`, and on `new Resend()` clients in server code, to `email.send()` from `vite-hub/email/server`:

- `reply_to` becomes `replyTo`.
- `const { data, error } = await ...send()` becomes `const [error, data] = await email.send()`.
- `nuxt-resend` becomes `vite-hub/nuxt`, and `vitehub.email` uses the Resend driver.
- The API key becomes Secret Env, read from `NUXT_RESEND_API_KEY`, or from the variables that `runtimeConfig.resend.apiKey` and `new Resend()` read.

`nuxt-resend` stays while a `useResend()` call is left that the codemod does not rewrite, such as a class field. The `resend` package stays while code uses `batch`, contacts, audiences, or CommonJS imports.

All migrated sends share one Email credential. Make sure that the sources refer to the same account. The report lists literal or dynamic API keys to move to Env, clients with different credential sources, `react` payloads, fields outside the portable Email message, and results that code reads in another shape. In `vite dev`, Email keeps messages in the development outbox unless `vitehub.email.remote` is `true`.

## nuxt-cron

The codemod moves each `defineCronHandler()` job from `server/<jobsDir>` to `server/schedules/<name>.ts` as a `defineSchedule()` Definition of ViteHub [Schedule](/docs/schedule). It drops a `.cron` suffix from the name. Presets such as `daily` become five-field cron strings.

- On Node, it sets `vitehub.schedule.runtime.driver` to `process`, so the Process Runtime runs the jobs in the server process as `nuxt-cron` did. `timeZone` stays.
- On other hosts, it sets `vitehub.schedule: true`. The host runs each Schedule from its own cron in UTC, so the codemod drops `timeZone` and reports it.

Jobs with six-field crons, computed times or time zones, or a shape that the codemod cannot read stay with `nuxt-cron`, which stays installed. Jobs that map to the same Schedule name all stay unchanged. The report says why, and lists `runOnInit`, which Schedule does not have.

The codemod stops without edits when:

- the config or module options are not object literals with explicit, unique property names,
- the app already has Schedule options,
- the host or the jobs directory is computed, or the host is `deno`,
- the host is Node and KV is turned off. Configure a default KV store before you retry.
