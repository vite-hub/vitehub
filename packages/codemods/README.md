# @vite-hub/codemods

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fcodemods&icon=npm)](https://npmx.dev/package/@vite-hub/codemods)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/codemods` moves an application to ViteHub. Each codemod edits the source files that it can change safely and ends with a report: the files it changed and a numbered list of manual follow-ups, with `file:line` where it applies.

The package requires Node.js 22.18 or newer. Read the [Codemods docs](https://vitehub.dev/docs/codemods) for a tutorial and what each codemod changes.

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
| `nuxthub` | A Nuxt app from NuxtHub 0.10 (`@nuxthub/core`) to ViteHub KV, Blob, Database, and cache through `vite-hub/nuxt` |
| `nuxt-safe-runtime-config` | A Nuxt app from the `nuxt-safe-runtime-config` module to ViteHub Env through `vite-hub/nuxt` |
| `t3-env` | A Nuxt app from `@t3-oss/env-nuxt` `createEnv()` to ViteHub Env through `vite-hub/nuxt` |
| `resend` | `nuxt-resend` and Resend SDK `emails.send()` calls to ViteHub Email through `vite-hub/nuxt` |
| `queue-workflow-verbs` | The old Queue and Workflow verbs to `sendQueue`, `useQueue`, `startWorkflow`, and `resumeWorkflow` |
| `nuxt-cron` | `nuxt-cron` jobs to ViteHub Schedule Definitions through `vite-hub/nuxt` |
| `root-accessors` | `db`, `schema`, `useDatabase`, `email`, `runSchedule`, and the Env accessors to the root of their primitive. `vitehub migrate` runs it. |
| `agent-surface` | A ViteHub app from the old Agent names to `invoker`, `loadAgent()`, `agentWorkflow()`, `extends`, and the merged Agent entries |
| `define-forms` | The former define forms of Schedule, Sandbox Task, Content, and Database to the one form of each |
| `one-entry-imports` | Imports of subpaths that moved into one entry per concept, and `vite-hub/task` to `nitro/task` |
| `vitehub-options` | The options that moved in `vitehub()`: `logs` into `observability`, Env declarations into `vitehub({ env })`, and `contentImportBase` removed |

## `root-accessors`

ViteHub moved the accessors of four primitives to the root of the primitive. `root-accessors` rewrites the imports of an app:

| Old import | New import |
| --- | --- |
| `db`, `schema`, `useDatabase`, `chunkParameters` from `vite-hub/database/drizzle` | `vite-hub/database` |
| `email` from `vite-hub/email/server` | `vite-hub/email` |
| `runSchedule` from `vite-hub/schedule/runtime` | `vite-hub/schedule`, and the `registry` option goes away |
| `useServerEnv`, `deriveSecret`, `loadServerEnv`, and the other Server Env helpers from `#vitehub/env/server` | `vite-hub/env` |
| `usePublicEnv` from `#vitehub/env/public`, in server code | `vite-hub/env` |

The `@vite-hub/*` forms move to the same owner roots. An app that lists `@vite-hub/env` and not `vite-hub` gets `@vite-hub/env`. The codemod also rewrites `declare module` augmentations, `vi.mock()` paths, and dynamic `import()` paths, and joins a moved import with an existing import of the same path. It removes `import registry from '#vitehub/schedule/registry'` when `runSchedule()` was its only use.

Browser code keeps `#vitehub/env/public`. The report lists what the codemod cannot move: `databases` and `agentDb`, which are no longer public, `useDatabase(name)?.` fallbacks, because `useDatabase()` now throws `DATABASE_NOT_FOUND` for an unknown name, and `imports` entries in `package.json` that map `#vitehub/env/*` by hand.

```sh
npx @vite-hub/codemods root-accessors [dir] [--dry-run]
# or, with @vite-hub/codemods installed
vitehub migrate [--dry-run]
```

## `define-forms`

ViteHub keeps one define form for each primitive. `define-forms` rewrites the former forms:

| Former form | New form |
| --- | --- |
| `defineSchedule("0 9 * * *", handler, { manual: true })` | `defineSchedule({ cron: "0 9 * * *", manual: true, handler })` |
| `defineSandboxTask({ run })` | `defineSandboxTask({ handler })` |
| `export const content = defineContent({ ... })` in `server/content.ts` | `export default defineContent({ ... })`, and `import content from` in the files that import it |
| `server/databases/config.ts` and the files beside it | `server/databases/default/index.ts` and the same files in `server/databases/default/` |
| `server/databases/migrations/` | `server/databases/default/migrations/` |
| `server/databases/<name>/config.ts` | `server/databases/<name>/index.ts` |

The codemod updates the import paths of moved files, also through the `~~`, `@@`, and `#server` aliases, and path strings such as `out: "./server/databases/migrations"` in `drizzle.config.ts`. It works in Nuxt layers too.

The report lists what it cannot change: Schedule options that are not an object literal, which it spreads into the object, Sandbox Task options that are not an object literal, dynamic imports of `server/content.ts`, helper files left in `server/databases/` that the new discovery reads as Databases, and lines in `package.json` and host config files that name the former Database paths.

```sh
npx @vite-hub/codemods define-forms [dir] [--dry-run]
```

## `vitehub-options`

`vitehub()` is the only config place, and `logs` is part of `observability`. `vitehub-options` edits every `vite.config.*` and `nuxt.config.*` in the app:

| Old | New |
| --- | --- |
| `vitehub({ logs: true })` | `vitehub({ observability: { logs: true } })` |
| `logs: { evlog, source }` | `observability: { evlog, logs: { source } }` |
| `defineConfig({ env: { server }, plugins: [vitehub()] })` | `vitehub({ env: { server } })` |
| `defineConfig({ env, plugins: [hubEnv()] })` | `hubEnv({ ...declarations })` |
| `vite: { env }` in `nuxt.config.ts` | `env` in the `vite-hub/nuxt` options |
| A top-level Vite key such as `kv` or `blob` | `vitehub({ kv })`, or the argument of `hubKv()` |
| `contentImportBase` | removed |

The report lists what the codemod cannot move: a `logs` or `env` value that is an expression, `env` set in two places, `vitehub({ env: false })` next to Env declarations, and source lines that name a renamed option type, such as `KVModuleOptions`, which is now `KVOptions`.

Sandbox Task option objects belong in `hubSandboxTask()`. The codemod passes them to an existing standalone plugin call without arguments. When the config uses `vitehub()` or `vite-hub/nuxt`, it keeps the options in place and reports a manual follow-up because the framework accepts only boolean Sandbox Task enablement.

```sh
npx @vite-hub/codemods vitehub-options [dir] [--dry-run]
```

## `queue-workflow-verbs`

ViteHub renamed the Queue and Workflow verbs so that each one says what it does. `queue-workflow-verbs` rewrites the app:

| Old | New |
| --- | --- |
| `runQueue()` | `sendQueue()` |
| `getQueue()` | `useQueue()` |
| `dynamicQueue.run()`, `dynamicQueue.get()` | `dynamicQueue.send()`, `dynamicQueue.use()` |
| `runWorkflow()` | `startWorkflow()` |
| `resumeWorkflowSignal()` | `resumeWorkflow()` |
| `.run()` of a handle from `createWorkflow()` | `.start()` |
| `WorkflowDeferOptions` | `WorkflowStartOptions` |

`deferWorkflow()` and the `defer()` method of a Workflow handle now return nothing, like `deferQueue()`. Where the code reads the result, for example to store the run id, the codemod calls `startWorkflow()` or `.start()` instead, which return the run as `deferWorkflow()` did. Where the code only awaits the call as a statement, it removes the `await`.

The codemod reads imports from `vite-hub/queue`, `vite-hub/workflow`, and their `@vite-hub/*` forms, also namespace imports, re-exports, and `<script>` blocks of `.vue` files. Named re-exports keep their local public names as aliases so consumers of an application's barrel keep working. Star and namespace re-exports need manual changes in their consumers, which the report lists. The report also lists object keys and strings with an old name, for example in a `vi.mock()` factory, and Workflow handles that a file exports, because other files call their methods. Detection includes migrations that only need manual follow-up.

```sh
npx @vite-hub/codemods queue-workflow-verbs [dir] [--dry-run]
```

## `nuxthub`

The codemod runs when `package.json` or `modules` lists `@nuxthub/core`, or when `nuxt.config` sets `hub`. It follows [Migrate from NuxtHub](https://vitehub.dev/docs/getting-started/migrate-from-nuxthub) and makes only the edits that keep the same behavior:

- `nuxt.config`: `'@nuxthub/core'` becomes `'vite-hub/nuxt'`, and `hub` becomes `vitehub` in place. `db: 'sqlite'` becomes `database: true`, and `kv`, `blob`, and `cache` stay `true`. The host comes from `nitro.preset`, then `cloudflare` when the app has a Wrangler config, then `node`. Driver options and other `hub` keys become follow-ups. MySQL stops the codemod, because ViteHub does not support it.
- `package.json`: removes `@nuxthub/core` and adds `vite-hub`. With a database, it adds `@vite-hub/database` and brings `drizzle-orm` and `drizzle-kit` to at least `^1.0.0-rc.5`, the lowest version that `@vite-hub/database` accepts.
- Schema: moves `server/db/schema.ts`, `server/db/schema.<dialect>.ts`, or the `server/db/schema/` folder to `server/databases/default/`, and writes `server/databases/default/index.ts` with `defineDatabase({ schema })`. Static, dynamic, CommonJS, and type imports follow the moved files. An aggregate exports every schema file, including an existing index; the report asks you to check conflicting exports. Legacy `relations()` declarations and each `db.query` use become follow-ups: rewrite them with Drizzle 1.0's `defineRelations()`, pass them to the Database Definition, and update relational filters before running the app.
- Imports: `hub:db` and `@nuxthub/db` become `vite-hub/database`, which exports `db` and `schema`. `hub:kv` and `hub:blob` become `vite-hub/kv` and `vite-hub/blob`. `hub:db:schema` becomes a relative import of the moved schema.
- KV and Blob calls: tuple-returning methods such as `const x = await kv.get(k)` and `await blob.del(p)` get a tuple and `if (error) throw error`, also for returns in async functions. `blob.delete()` becomes `blob.del()`. `blob.serve()` returns a Response unchanged; in an H3 handler the event argument becomes `event.req`. An unknown event or an unsupported use of a tuple becomes a follow-up with `file:line`.
- Wrangler config: the D1 `migrations_table: "_hub_migrations"` goes, because ViteHub must not reuse it. On Cloudflare, KV, cache, and Blob options keep the resource that matches the original binding or its `KV`, `CACHE`, or `BLOB` default. R2 options keep the bucket's jurisdiction too. Unrelated bindings stay in place. The report lists the matched entries to remove after checking the generated options, and the D1 options to set by hand.

The codemod does not move local data or baseline the database. The follow-ups list the commands: copy `.data/db/sqlite.db` and `.data/kv`, `vitehub database generate --name baseline`, the baseline review, `vitehub database migrate`, and `vitehub blob put` for each blob. Node uses `.vitehub/data/kv`; Cloudflare on the Node development runner uses `.vitehub/data/kv-cloudflare/<binding>`. Binding-backed development reads its namespace instead. Review the baseline folder's `migration.sql` and keep its `snapshot.json`. Calls to the removed `hubBlob()`, `hubKV()`, `hubDatabase()`, and `hubAI()` helpers also become follow-ups.

## `nuxt-safe-runtime-config`

The codemod reads one of the two schema sources of the module:

- `safeRuntimeConfig.envSchema` points at a `.env.example` with `@env-spec` annotations. The codemod replaces it with `envSchema(new URL("./.env.example", import.meta.url), { prefix: "NUXT_" })` from `@vite-hub/env/vite`. With the `NUXT_` prefix, `NUXT_PUBLIC_*` keys become Public Env and other `NUXT_*` keys become Server Env, with the same names and variables. Server `paths` stay the same. Public Env is flat, so a nested public path falls back to its flat name.
- `safeRuntimeConfig.$schema` is a Valibot, Zod 3, Zod 4, or ArkType schema, inline or in a module. For Zod 4 before 4.2, the codemod calls `toJSONSchema()` from the app's own Zod. The codemod converts it to JSON Schema and writes `env()`, `env.number()`, `env.boolean()`, and `env.enum()` declarations under `vitehub.env`. Each declaration reads its `NUXT_*` variable with `env.source()`. A `process.env.NAME || fallback` value reads `NAME` with a source that skips empty values, as `||` did, and keeps `fallback` as the default. Literal `runtimeConfig` values, including empty strings, become defaults, and keys under `runtimeConfig.public` become Public Env with `mode: "build"`. Credential-like server names become `secret: true`.

When `safeRuntimeConfig` declares neither and the app has no layers, the module validates nothing, so the codemod removes it from `modules`, `nuxt.config`, and `package.json`. It stops instead when code still calls `useSafeRuntimeConfig()`. Schema-free removal also stops when the config extends layers, uses a root spread, or has automatic `layers/` directories: inherited schemas and composable calls are unknown. Review those layers and remove the module by hand, or declare the schema in the app config before retrying.

In both cases the codemod replaces `'nuxt-safe-runtime-config'` with `'vite-hub/nuxt'` in `modules`, removes `safeRuntimeConfig` and the migrated `runtimeConfig` keys, sets `vitehub.host`, and swaps the package in `package.json`. It rewrites `useSafeRuntimeConfig()` to `useServerEnv()` from `vite-hub/env` in server files and to `usePublicEnv()` from `#vitehub/env/public` in app files.

An existing `modules` property must be an array literal. If it is an expression such as `buildModules()`, or a root spread could supply an inherited list, the codemod stops without writing files; make the list explicit before retrying. A dynamic `nitro.preset` also stops the codemod unless a ViteHub host is already explicit; use a string literal or set `vitehub.host` before retrying. Consumed local layers inside the app are included in call-site migration. Local layers outside the app directory are left unchanged and named in the report for manual migration before using the migrated app.

The report lists what Env cannot express and what the codemod could not rewrite: constraints and transforms, unions, JSON arrays and objects, non-empty secret defaults that are omitted from the server build, secret reads that need `.unseal()`, reads that pass the config object on, `useRuntimeConfig()` reads of migrated keys, template reads, and ESLint rules of the module. Zod 3 input coercion is reported because Env accepts different inputs. Unsupported Zod 3 wrappers, including `.catch()` fallbacks, stay in `runtimeConfig` for manual migration. Public Env values are fixed when you build, while Nuxt applied `NUXT_PUBLIC_*` overrides when the server started.

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

The codemod rewrites `emails.send()` on `useResend()` clients of `nuxt-resend` and on `new Resend()` clients in server code to `email.send()` from `vite-hub/email`. It renames `reply_to` to `replyTo` and turns `const { data, error } = await ...send()` into `const [error, data] = await email.send()`. It replaces `nuxt-resend` with `vite-hub/nuxt` and sets `vitehub.email` to the Resend driver. The API key is Secret Env read from `NUXT_RESEND_API_KEY`, or from the variables that `runtimeConfig.resend.apiKey` and `new Resend()` read.

Code that checks `runtimeConfig.resend.apiKey` keeps working: the codemod preserves existing runtime config and declares the module's key when it removes `nuxt-resend`, even when it cannot detect readers. Dynamic runtime config needs a manual declaration. Credential inference follows global Env reads and proven runtime-config bindings; unknown sources need manual migration. `nuxt-resend` stays while a `useResend()` call is left that the codemod does not rewrite, such as a class field, and the `resend` package stays while code uses `batch`, contacts, audiences, or CommonJS imports. The report lists literal or dynamic API keys to move to Env, clients with different credential sources, `react` payloads, fields outside the portable Email message, and results that code reads in another shape. All migrated sends share one Email credential. Check that the sources refer to the same account; keep clients with different credentials on the SDK or configure them separately by hand. In `vite dev`, Email keeps messages in the development outbox unless `vitehub.email.remote` is `true`.

## `nuxt-cron`

The codemod moves each `defineCronHandler()` job from `server/<jobsDir>` to `server/schedules/<name>.ts` as a `defineSchedule()` Definition, and drops a `.cron` suffix from the name. Presets such as `daily` become five-field cron strings, and functions that return a literal cron keep it. On Node, it sets `vitehub.schedule.runtime.driver` to `process`, so the Process Runtime runs the jobs in the server process as `nuxt-cron` did, and `timeZone` stays. On other hosts, it sets `vitehub.schedule: true`: the host runs each Schedule from its own cron in UTC, and the codemod drops `timeZone` and reports it.

Jobs with six-field crons, computed times or time zones, or a shape the codemod cannot read stay with `nuxt-cron`, which stays installed, and the report says why. A computed module time zone keeps each job that does not override it with a literal. The report also lists `runOnInit`, which Schedule does not have.

Jobs that map to the same Schedule name all stay unchanged, including names from existing files with another source extension or an `index` file. Configuration and module options must be object literals with explicit, unique property names. Opaque option objects, spreads, dynamic keys, or accessors stop the migration without edits; jobs with such options stay with `nuxt-cron`. Inline `vite-hub/nuxt` options take precedence over root `vitehub` options. Existing root or inline Schedule options require a manual migration; the codemod stops without edits. It also stops when the effective host or jobs directory is computed, or the host is `deno`, whose Nuxt integration cannot provide Schedule. On Node it enables KV when absent, and stops if KV is explicitly disabled: configure a default KV store before retrying.

## `agent-surface`

```sh
npx @vite-hub/codemods agent-surface [dir] [--dry-run]
```

The codemod updates an app that imports `vite-hub/agent` or `@vite-hub/agent`, with or without Nuxt:

- `AgentActor` and `AgentInvokerProfile` become `AgentInvoker`, `getAgentFromRegistry` becomes `loadAgent`, and `workflow` becomes `agentWorkflow`, in imports and in the code that reads them.
- `agent/process-host` and `agent/runtime/process` become `agent/process`, `agent/invocations/d1` and `agent/invocations/sqlite` become `agent/invocations`, and `agent/state/sqlite` becomes `agent/state`. Two imports that land on the same entry merge into one.
- `defineAgent({ preset: "babysitter", presets: { babysitter } })` becomes `defineAgent({ extends: babysitter })`.
- `providers: { state: { provider } }` in Agent options (`vitehub({ agent })`, a `vitehub.agent` block, or `hubAgent()`) becomes `driver`. The same applies to `scheduler` and `sandbox`.
- `context: { actor }` in an Invocation input, `context.actor`, and a destructured `actor` next to other Agent context fields in a `defineAgent()` or `defineCapability()` callback become `invoker`.

The report lists what it leaves: `getAgent()` and the root helpers that are no longer public, the private `agent/invocations/default` entry, a dynamic `preset` name, and an `actor` read that could also be another field, such as a GitHub sender.

## `one-entry-imports`

The codemod moves each import of a subpath that ViteHub folded into one entry. It rewrites `import`, `export ... from`, `import()`, `import("...").Type`, `declare module`, and `vi.mock()` paths, and joins a moved import with an import of the new path in the same file.

| Old path | New path |
| --- | --- |
| `vite-hub/source/{file,files,github,glob,markdown}` | `vite-hub/source` |
| `vite-hub/env/{presets,provider,schema,secret}` | `vite-hub/env` |
| `vite-hub/env/{auth,http}` | `vite-hub/env/bridge` |
| `vite-hub/blob/{content-type,ensure,reference}` | `vite-hub/blob`, or `vite-hub/blob/client` for `content-type` in browser code |
| `vite-hub/browser/actions` | `vite-hub/browser` |
| `vite-hub/connections/http` | `vite-hub/connections` |
| `vite-hub/task` | `nitro/task`, and `nitro/types` for the task types |

The same moves apply to the `@vite-hub/*` paths. The report lists strings that name an old path, such as aliases and test stubs. When an app moves to `nitro/task` and lists neither `nitro` nor `nuxt` in `package.json`, the report asks to add `nitro`.

For `blob/content-type`, only explicit server files use the Blob root. Browser, shared, and unclassified files use `blob/client`, which also works on the server. `env/server` stays separate for operations on an explicit Env registry; the Env root reads the generated app registry.

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
