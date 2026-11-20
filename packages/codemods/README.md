# @vite-hub/codemods

[![npm version](https://img.shields.io/npm/v/@vite-hub/codemods)](https://npmx.dev/package/@vite-hub/codemods)
[![license](https://img.shields.io/static/v1?label=license&message=Apache-2.0&color=blue)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://img.shields.io/static/v1?label=docs&message=vitehub.dev&color=blue)](https://vitehub.dev/docs)

`@vite-hub/codemods` moves an application to ViteHub. Each codemod edits the source files that it can change safely and ends with a report: the files it changed and a numbered list of manual follow-ups, with `file:line` where it applies.

The package requires Node.js 24.15 or newer. Read the [Codemods docs](https://vitehub.dev/docs/codemods) for a tutorial and what each codemod changes.

## Migrate an app

```sh
npx @vite-hub/codemods [dir] [--dry-run]
```

The command finds every module in the app that a codemod supports and runs those codemods one after another, so each one sees the edits of the ones before it. `dir` is the application directory. It defaults to the current directory. `--dry-run` prints the combined edits as diffs and the report, and writes nothing.

The report lists, for each codemod, why it ran and what it did, then the files it changed, a numbered list of manual follow-ups with `file:line`, notes, and the commands to run next. A codemod that cannot migrate the app changes nothing and says why; the others still run. The report also warns when `package.json` requires a Nuxt version before 5, directly or through a pnpm `catalog:` in `pnpm-workspace.yaml`, because ViteHub supports Nuxt 5 and Nitro 3 only. The codemods do not upgrade Nuxt or install packages. Nuxt 5 also stops auto-importing Nitro helpers such as `defineEventHandler` in server code. Set `experimental: { nitroAutoImports: true }` to keep them, or import them as the Nuxt 5 build error lists.

The migration uses a unique scratch directory and preserves existing `.vitehub-migrate` directories. If a codemod would edit a symbolic link or a file inside a linked directory, it stops without applying that codemod's edits. Running one codemod does the same. Replace the link with a local file or directory before retrying.

The command exits with `0` when every codemod completes, also when they report follow-ups, and when no codemod applies. A plain Vite or Node app needs no `nuxt.config`. It exits with `1` when a codemod could not migrate, when the folder has neither `package.json` nor `nuxt.config`, or when `nuxt.config` does not parse.

## Upgrade ViteHub

```sh
vitehub migrate [dir] [--dry-run]
```

`vitehub migrate` runs the upgrade codemods, the ones that move an app from an older ViteHub API, in this order: `vitehub-options`, `define-forms`, `runtime-contracts`, `root-accessors`, `one-entry-imports`, `queue-workflow-verbs`, `queue-durations`, `result-tuples`, `agent-surface`, `driver-key`, `renamed-apis`, `tsconfig-paths`, `shell-driver`, `access-spellings`, `auth-sign-in`, `channels`, `auth-accessors`, `workspace-repo`, `kv-list-prefix`, and `cli-yes-flag`. Each one sees the edits of the ones before it, and the report is the same as above. Install `@vite-hub/codemods` as a development dependency first. The codemods that move an app from another module, such as `nuxthub`, do not run. The report ends with a reminder to run Vite Doctor: rule `VHUB0003` finds Result calls, such as `await email.send(...)`, whose error the code drops.

## Run one codemod

```sh
npx @vite-hub/codemods nuxt-safe-runtime-config [dir] [--dry-run]
```

The command runs only the named codemod. Run it with `--help` to list the codemods. It exits with `1` when the codemod cannot migrate, for example when it cannot find or parse `nuxt.config`.

| Codemod | Moves |
| --- | --- |
| `nuxthub` | A Nuxt app from NuxtHub 0.10 (`@nuxthub/core`) to ViteHub KV, Blob, Database, and cache through `vite-hub/nuxt` |
| `nuxt-safe-runtime-config` | A Nuxt app from the `nuxt-safe-runtime-config` module to ViteHub Env through `vite-hub/nuxt` |
| `driver-key` | A ViteHub app to `driver` as the one key that selects a backend |
| `t3-env` | A Nuxt app from `@t3-oss/env-nuxt` `createEnv()` to ViteHub Env through `vite-hub/nuxt` |
| `resend` | `nuxt-resend` and Resend SDK `emails.send()` calls to ViteHub Email through `vite-hub/nuxt` |
| `queue-workflow-verbs` | The old Queue and Workflow verbs to `sendQueue`, `useQueue`, `startWorkflow`, and `resumeWorkflow` |
| `queue-durations` | Queue `delaySeconds` to `delay` with a duration such as `"60s"`, and `retentionSeconds` to `retention`. `vitehub migrate` runs it. |
| `result-tuples` | `startWorkflow()`, `getWorkflowRun()`, `cancelWorkflow()`, `resumeWorkflow()`, the Workflow handle methods, and `runSchedule()` to `[error, data]` reads. `vitehub migrate` runs it. |
| `nuxt-cron` | `nuxt-cron` jobs to ViteHub Schedule Definitions through `vite-hub/nuxt` |
| `nuxt-better-auth` | A Nuxt app from `@nuxtjs/better-auth` to ViteHub Auth through `vite-hub/nuxt`: `server/auth.ts`, `app/auth.client.ts`, and `definePageMeta({ auth })` |
| `docus` | A Docus site to `@vite-hub/docs`: the module, the site options, and the page frontmatter |
| `nuxt-content` | Nuxt Content collections in `content.config.ts` to ViteHub Content Sources through `vite-hub/nuxt` |
| `runtime-contracts` | `vite-hub/runtime/h3` and `vite-hub/runtime/node` imports, Evlog names from `vite-hub/logs`, and `checkRateLimit()` calls to the new contracts |
| `root-accessors` | `db`, `schema`, `useDatabase`, `email`, `runSchedule`, and the Env accessors to the root of their primitive |
| `agent-surface` | A ViteHub app from the old Agent names to `invoker`, `loadAgent()`, `agentWorkflow()`, `extends`, and the merged Agent entries |
| `renamed-apis` | An app from the ViteHub names that this release renamed, such as `hubDb` and `kv.del()` |
| `define-forms` | The former define forms of Queue, Schedule, Sandbox Task, Workflow, Content, and Database to the one form of each |
| `one-entry-imports` | Imports of subpaths that moved into one entry per concept, and `vite-hub/task` to `nitro/task` |
| `vitehub-options` | The options that moved in `vitehub()`: `preset` to `host`, `observability.logs` to `logs`, Env declarations into `vitehub({ env })`, and `devtools` and `contentImportBase` removed |
| `tsconfig-paths` | `#vitehub/*` entries of tsconfig `paths` that point into `.vitehub/` or `.nuxt/`, which ViteHub now types itself |
| `shell-driver` | The Shell `provider` names to `driver`: `createShellRuntime({ driver })`, `ShellDriver`, and `createJustBashDriver()`. `vitehub migrate` runs it. |
| `access-spellings` | Realtime `auth: true` to `authorize: true`, and MCP `public: true` to `access: "public"`. `vitehub migrate` runs it. |
| `auth-sign-in` | `vitehub({ auth: { redirects } })` and `access.signIn.callbackURL` to `access: { signIn, afterSignIn }` in `server/auth.ts`. `vitehub migrate` runs it. |
| `channels` | Agent `http()` calls to `channelAdapter("http", options)` where safe, and webhook secrets and signatures to the names of Webhooks. `vitehub migrate` runs it. |
| `auth-accessors` | Auth `auth` and `getAuth()` to `useAuth()`, and `isGitHubOrgMember()` to `checkGitHubOrgMember()`. `vitehub migrate` runs it. |
| `workspace-repo` | The GitHub Workspace Store option `repository` to `repo`. `vitehub migrate` runs it. |
| `kv-list-prefix` | `kv.keys(base)` to `kv.list({ prefix })`, and `kv.clear(base)` to `kv.clear({ prefix })`. `vitehub migrate` runs it. |
| `cli-yes-flag` | Replace old CLI prompt flags in scripts and CI, or report a manual migration. `vitehub migrate` runs it. |

## `runtime-contracts`

ViteHub moved the request context helpers to `vite-hub/runtime`, made private runtime and Auth entries private, and changed `checkRateLimit()` to return a Result. `runtime-contracts` rewrites an app:

| Old code | New code |
| --- | --- |
| `getRuntimeContext`, `getStandardContext`, and the Standard Context types from `vite-hub/runtime/h3` | `vite-hub/runtime`. `H3RuntimeContext` and `H3RuntimeContextOptions` become `RequestRuntimeContext` and `RuntimeContextOptions`. |
| `nodeRuntimeResources` from `vite-hub/runtime/node` | `vite-hub/agent/capabilities` |
| `initLogger`, `useLogger`, and the other Evlog names from `vite-hub/logs` | `evlog`. The LogSource names stay in `vite-hub/logs`. |
| `const decision = await checkRateLimit(...)` | `const [checkRateLimitError, decision] = await checkRateLimit(...)`, then `if (checkRateLimitError) throw checkRateLimitError`, which keeps the old behavior |

The `@vite-hub/runtime/*` forms move to the same places. The report lists what needs a person: `installStandardContext()`, the other names of `vite-hub/runtime/node`, `@vite-hub/runtime/shutdown`, the Auth setters, factories, and access helpers that left `vite-hub/auth/server`, the `vite-hub/auth/runtime/server`, `vite-hub/auth/console`, and `vite-hub/auth/console-runtime` entries, and a `checkRateLimit()` call that is not a `const` declaration.

```sh
npx @vite-hub/codemods runtime-contracts [dir] [--dry-run]
```

## `renamed-apis`

ViteHub renamed some APIs. `renamed-apis` rewrites the code of an app that uses ViteHub:

| Old | New |
| --- | --- |
| `hubDb` from `@vite-hub/database/vite` or `@vite-hub/database/nuxt` | `hubDatabase` |
| `hubKv` from `@vite-hub/kv/vite` | `hubKV` |
| `createWorkspaceDriver` from `@vite-hub/workspace/mountx` | `createMountxDriver` |
| `fetch` from `vite-hub/workspace` or `@vite-hub/workspace`, the URL Source | `url` |
| `console` from `vite-hub/console/server` | `agentConsole` |
| `kv.del()`, `blob.del()`, `kv.store(name).del()` | `.delete()` |
| `deriveSecret(purpose, event)` | `deriveSecret(purpose, { event })` |
| `"kv.del"`, `"blob.del"`, `"kv_del"`, and `"blob_del"` strings, such as operation names and Console MCP tool names in a client | `"kv.delete"`, `"blob.delete"`, `"kv_delete"`, and `"blob_delete"` |

The codemod renames the uses of an import too, and the names in `const { hubKv } = await import("@vite-hub/kv/vite")`. When a file declares the same name again, it renames only the import and lists the file. The report lists what the codemod cannot change: a `.del()` call on another value in a file that imports `kv` or `blob`, a `deriveSecret()` call with a root secret, `package.json` scripts that call `vitehub kv del` or `vitehub blob del`, and env and Wrangler files that set `NUXT_APP_SECRET` without `VITEHUB_SECRET`. ViteHub no longer reads `NUXT_APP_SECRET`, but other modules such as nuxt-og-image do, so the report does not ask you to remove it. The codemod never prints or copies a secret value.

```sh
npx @vite-hub/codemods renamed-apis [dir] [--dry-run]
```

## `root-accessors`

ViteHub moved the accessors of four primitives to the root of the primitive. `root-accessors` rewrites the imports of an app:

| Old import | New import |
| --- | --- |
| `db`, `schema`, `useDatabase`, `chunkParameters` from `vite-hub/database/drizzle` | `vite-hub/database` |
| `email` from `vite-hub/email/server` | `vite-hub/email` |
| `runSchedule` from `vite-hub/schedule/runtime` | `vite-hub/schedule`, and the `registry` option goes away |
| `useServerEnv`, `deriveSecret`, `loadServerEnv`, and the other Server Env helpers from `#vitehub/env/server` | `vite-hub/env` |
| `usePublicEnv` from `#vitehub/env/public`, in server code | `vite-hub/env` |

The `@vite-hub/*` forms move to the same owner roots. An app that lists `@vite-hub/env` and not `vite-hub` gets `@vite-hub/env`. The codemod also rewrites `declare module` augmentations, `vi.mock()` paths, and dynamic `import()` paths, and joins a moved import with an existing import of the same path. It removes `import registry from '#vitehub/schedule/registry'` when `runSchedule()` was its only use. A Drizzle call on the result of `useDatabase()`, such as `useDatabase("notes").select()` or `database.select()` after `const database = useDatabase("notes")`, goes through `db`: `useDatabase("notes").db.select()`, because `useDatabase()` returns `{ db, schema, relations }`.

The query rewrite keeps unrelated imports and local accessors. If a local declaration shadows an imported Database accessor, it leaves the calls and reports a follow-up.

Browser code keeps `#vitehub/env/public`. The report lists what the codemod cannot move: `databases` and `agentDb`, which are no longer public, `useDatabase(name)?.` fallbacks, because `useDatabase()` now throws `DATABASE_NOT_FOUND` for an unknown name, and `imports` entries in `package.json` that map `#vitehub/env/*` by hand.

```sh
npx @vite-hub/codemods root-accessors [dir] [--dry-run]
```

## `define-forms`

ViteHub keeps one define form for each primitive. `define-forms` rewrites the former forms:

| Former form | New form |
| --- | --- |
| `defineQueue(handler, { concurrency: 5 })` | `defineQueue({ handler, concurrency: 5 })` |
| `defineSchedule("0 9 * * *", handler, { manual: true })` | `defineSchedule({ cron: "0 9 * * *", manual: true, handler })` |
| `defineSandboxTask({ run })` | `defineSandboxTask({ handler })` |
| `defineWorkflow("onboard-user", async (payload: Payload, { steps }) => {}, { native })` | `defineWorkflow<Payload>({ handler: async ({ payload, steps }) => {}, native })`. The file path is the name. |
| `createWorkflow("welcome", async (payload: Payload) => {})` | `createWorkflow<Payload>("welcome", async ({ payload }) => {})` |
| `export const content = defineContent({ ... })` in `server/content.ts` | `export default defineContent({ ... })`, and `import content from` in the files that import it |
| `server/databases/config.ts` and the files beside it | `server/databases/default/index.ts` and the same files in `server/databases/default/` |
| `server/databases/migrations/` | `server/databases/default/migrations/` |
| `server/databases/<name>/config.ts` | `server/databases/<name>/index.ts` |

The codemod updates the import paths of moved files, also through the `~~`, `@@`, and `#server` aliases, and path strings such as `out: "./server/databases/migrations"` in `drizzle.config.ts`. It works in Nuxt layers too.

The codemod leaves Queue handlers unchanged. They still receive the same job object, so destructuring it (for example, `({ payload }) => payload.email`) is optional. A one-argument call whose argument could be a definition object is left alone unless the codemod can identify a handler.

The report lists what needs review: Queue calls with spread arguments or options the codemod cannot safely flatten, Schedule options that are not an object literal (which it spreads into the object), Sandbox Task options that are not an object literal, dynamic imports of `server/content.ts`, helper files left in `server/databases/` that the new discovery reads as Databases, and lines in `package.json` and host config files that name the former Database paths.

It also reports Workflow option expressions, spreads, and ambiguous handlers, as well as local Workflow handlers that it wraps to keep their positional arguments.

```sh
npx @vite-hub/codemods define-forms [dir] [--dry-run]
```

## `vitehub-options`

`vitehub()` is the only config place, and `logs` is its own key. `vitehub-options` edits every `vite.config.*` and `nuxt.config.*` in the app:

| Old | New |
| --- | --- |
| `vitehub({ preset })`, `vitehub: { preset }` in `nuxt.config.ts` | `host` |
| `sandbox: true` | `sandboxTask: true` |
| `vitehub({ observability: { logs: true } })` | `vitehub({ logs: true })` |
| `logs: { evlog, source }` | `observability: { evlog }, logs: { source }` |
| `defineConfig({ env: { server }, plugins: [vitehub()] })` | `vitehub({ env: { server } })` |
| `defineConfig({ env, plugins: [hubEnv()] })` | `hubEnv({ ...declarations })` |
| `vite: { env }` in `nuxt.config.ts` | `env` in the `vite-hub/nuxt` options |
| A top-level Vite key such as `kv` or `blob` | `vitehub({ kv })`, or the argument of `hubKV()` |
| `devtools`, `contentImportBase` | removed |

The report lists what the codemod cannot move: `preset` next to `host`, `sandbox` options that are not a boolean, `cloudflare.secretsFile`, an `observability` or `env` value that is an expression, `env` set in two places, `vitehub({ env: false })` next to Env declarations, and source lines that name a renamed option type, such as `KVModuleOptions`, which is now `KVOptions`.

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

## `queue-durations`

Queue `delaySeconds` is now `delay`, and `retentionSeconds` is now `retention`. `delay` takes a duration string, such as `"60s"`. `retention` takes a duration or a number of seconds. `queue-durations` rewrites the app:

| Old | New |
| --- | --- |
| `{ delaySeconds: 60 }` | `{ delay: "60s" }` |
| `{ delaySeconds: 24 * 60 * 60 }` | `{ delay: "86400s" }` |
| `{ retentionSeconds: 3600 }` | `{ retention: 3600 }` |
| `onError` returns `{ retry: { delaySeconds: 30 } }` | `{ retry: { delay: "30s" } }` |

It reads the options of `sendQueue()`, `deferQueue()`, `dynamicQueue.send()`, `dynamicQueue.defer()`, and `send()` and `sendBatch()` of a `useQueue()` client, also without an import in Nuxt server code, and of the old verbs `runQueue()` and `getQueue()`. Cloudflare's native `message.retry()` and `batch.retryAll()` keep `delaySeconds`. The report lists a `delay` value that is not a number in the code and old names that are left, such as options in a variable.

```sh
npx @vite-hub/codemods queue-durations [dir] [--dry-run]
```

## `nuxthub`

The codemod runs when `package.json` or `modules` lists `@nuxthub/core`, or when `nuxt.config` sets `hub`. It follows [Migrate from NuxtHub](https://vitehub.dev/docs/getting-started/migrate-from-nuxthub) and makes only the edits that keep the same behavior:

- `nuxt.config`: `'@nuxthub/core'` becomes `'vite-hub/nuxt'`, and `hub` becomes `vitehub` in place. `db: 'sqlite'` becomes `database: true`, and `kv`, `blob`, and `cache` stay `true`. The host comes from `nitro.preset`, then `cloudflare` when the app has a Wrangler config, then `node`. Driver options and other `hub` keys become follow-ups. MySQL stops the codemod, because ViteHub does not support it.
- `package.json`: removes `@nuxthub/core` and adds `vite-hub`. With a database, it adds `@vite-hub/database` and brings `drizzle-orm` and `drizzle-kit` to at least `^1.0.0-rc.5`, the lowest version that `@vite-hub/database` accepts.
- Schema: moves `server/db/schema.ts`, `server/db/schema.<dialect>.ts`, or the `server/db/schema/` folder to `server/databases/default/`, and writes `server/databases/default/index.ts` with `defineDatabase({ schema })`. Like NuxtHub, it reads only the top-level files of the folder, and skips files for another dialect, such as `users.sqlite.ts` in a Postgres app. Static, dynamic, CommonJS, and type imports follow the moved files. An aggregate exports every schema file, including an existing index; the report asks you to check conflicting exports. Legacy `relations()` declarations and each `db.query` use become follow-ups: rewrite them with Drizzle 1.0's `defineRelations()`, pass them to the Database Definition, and update relational filters before running the app. A query with a `where` function gets its own follow-up, because Drizzle 1.0 reads `where` as an object.
- Database options: for Postgres, the Definition reads `POSTGRES_URL`, then `POSTGRESQL_URL`, then `DATABASE_URL`, as NuxtHub did. `connection.hyperdriveId` becomes `cloudflare.hyperdriveId`. `driver: 'd1-http'` becomes `cloudflare: { databaseId, http: true }`, and the report lists the `NUXT_HUB_CLOUDFLARE_*` variables to rename. `casing` becomes a follow-up, because Drizzle 1.0 sets casing per table. Schema files in local layers (`layers/*` and relative `extends`) become follow-ups too.
- Imports: `hub:db` and `@nuxthub/db` become `vite-hub/database`, which exports `db` and `schema`. `hub:kv` and `hub:blob` become `vite-hub/kv` and `vite-hub/blob`. `hub:db:schema` becomes a relative import of the moved schema.
- KV and Blob calls: tuple-returning methods such as `const x = await kv.get(k)` and `await blob.del(p)` get a tuple and `if (error) throw error`, also for returns in async functions. `blob.delete()` becomes `blob.del()`. `blob.serve()` returns a Response unchanged; in an H3 handler the event argument becomes `event.req`. An unknown event or an unsupported use of a tuple becomes a follow-up with `file:line`.
- Wrangler config: the D1 `migrations_table: "_hub_migrations"` goes, because ViteHub must not reuse it. On Cloudflare, KV, cache, and Blob options keep the resource that matches the original binding or its `KV`, `CACHE`, or `BLOB` default. R2 options keep the bucket's jurisdiction too. Unrelated bindings stay in place. The report lists the matched entries to remove after checking the generated options, and the D1 options to set by hand.
- Modules that expect NuxtHub: ViteHub does not emulate NuxtHub's module APIs, so the codemod reports them as follow-ups and changes nothing. It finds the `hub:db:schema:extend`, `hub:db:migrations:dirs`, and `hub:db:queries:paths` hooks in `nuxt.config`, in the `modules/` folder, and in local layers (`layers/*` and relative `extends` paths), and points to `vitehub.databases` contributions or a custom migration. It also reports `studio.media.external` of nuxt-studio, and each installed dependency whose `package.json` lists `@nuxthub/core` in `peerDependencies` or `dependencies`, such as `@evlog/nuxthub`.

The codemod does not move local data or baseline the database. The follow-ups list the commands: copy `.data/db/sqlite.db` (or `.data/db/pglite` for Postgres) and `.data/kv`, `vitehub database generate --name baseline`, the baseline review, `vitehub database migrate`, and `vitehub blob put` for each blob. Node uses `.vitehub/data/kv`; Cloudflare on the Node development runner uses `.vitehub/data/kv-cloudflare/<binding>`. Binding-backed development reads its namespace instead. Review the baseline folder's `migration.sql` and keep its `snapshot.json`. Calls to the removed `hubBlob()`, `hubKV()`, `hubDatabase()`, and `hubAI()` helpers also become follow-ups.

## `nuxt-safe-runtime-config`

The codemod reads one of the two schema sources of the module:

- `safeRuntimeConfig.envSchema` points at a `.env.example` with `@env-spec` annotations. The codemod replaces it with `envSchema(new URL("./.env.example", import.meta.url), { prefix: "NUXT_" })` from `@vite-hub/env/vite`. With the `NUXT_` prefix, `NUXT_PUBLIC_*` keys become Public Env and other `NUXT_*` keys become Server Env, with the same names and variables. Server `paths` stay the same. Public Env is flat, so a nested public path falls back to its flat name.
- `safeRuntimeConfig.$schema` is a Valibot, Zod 3, Zod 4, or ArkType schema, inline or in a module. For Zod 4 before 4.2, the codemod calls `toJSONSchema()` from the app's own Zod. The codemod converts it to JSON Schema and writes `env()`, `env.number()`, `env.boolean()`, and `env.enum()` declarations under `vitehub.env`. Each declaration reads its `NUXT_*` variable with `env.source()`. A `process.env.NAME || fallback` value reads `NAME` with `env.source()` and keeps `fallback` as the default. Env treats an empty variable as unset, as `||` did. Literal `runtimeConfig` values, including empty strings, become defaults, and keys under `runtimeConfig.public` become Public Env with `mode: "build"`. Credential-like server names become `secret: true`.

When `safeRuntimeConfig` declares neither and the app has no layers, the module validates nothing, so the codemod removes it from `modules`, `nuxt.config`, and `package.json`. It stops instead when code still calls `useSafeRuntimeConfig()`. Schema-free removal also stops when the config extends layers, uses a root spread, or has automatic `layers/` directories: inherited schemas and composable calls are unknown. Review those layers and remove the module by hand, or declare the schema in the app config before retrying.

In both cases the codemod replaces `'nuxt-safe-runtime-config'` with `'vite-hub/nuxt'` in `modules`, removes `safeRuntimeConfig` and the migrated `runtimeConfig` keys, sets `vitehub.host`, and swaps the package in `package.json`. It rewrites `useSafeRuntimeConfig()` to `useServerEnv()` from `vite-hub/env` in server files and to `usePublicEnv()` from `#vitehub/env/public` in app files.

An existing `modules` property must be an array literal. If it is an expression such as `buildModules()`, or a root spread could supply an inherited list, the codemod stops without writing files; make the list explicit before retrying. A dynamic `nitro.preset` also stops the codemod unless a ViteHub host is already explicit; use a string literal or set `vitehub.host` before retrying. Consumed local layers inside the app are included in call-site migration. Local layers outside the app directory are left unchanged and named in the report for manual migration before using the migrated app.

The report lists what Env cannot express and what the codemod could not rewrite: constraints and transforms, unions, JSON arrays and objects, non-empty secret defaults that are omitted from the server build, secret reads that need `.unseal()`, reads that pass the config object on, `useRuntimeConfig()` reads of migrated keys, template reads, and ESLint rules of the module. Zod 3 input coercion is reported because Env accepts different inputs. Unsupported Zod 3 wrappers, including `.catch()` fallbacks, stay in `runtimeConfig` for manual migration. Public Env values are fixed when you build, while Nuxt applied `NUXT_PUBLIC_*` overrides when the server started.

[`examples/nuxt-safe-runtime-config`](./examples/nuxt-safe-runtime-config) is a Nuxt app that uses the module. The end-to-end test builds and starts it, migrates a copy, type-checks and builds the copy with `vite-hub/nuxt`, and compares the typed values that one server route returns:

```sh
corepack pnpm exec vp run codemods:e2e
```

## `driver-key`

`driver` is the only key that selects the backend of a resource. An old key fails with a `*_RENAMED_*_KEY` error that names `driver`, so a config cannot fall back to another backend without a warning. The codemod renames the old keys and the old names of host drivers:

| Before | After |
| --- | --- |
| `queue`, `workflow`, `rateLimit`, `sandboxTask`: `provider` | `driver` |
| `realtime: { authority }` | `realtime: { driver }` |
| Workspace `store: { provider }` | `store: { driver }` |
| `createBrowser({ provider })` | `createBrowser({ driver })` |
| Blob `driver: "cloudflare-r2"`, `"vercel-blob"` | `"cloudflare"`, `"vercel"` |
| KV `driver: "cloudflare-kv-binding"` | `"cloudflare"` |
| Email `driver: "cloudflare-email"` | `"cloudflare"` |
| Cache `driver: "cloudflare-kv-binding"`, `"vercel-runtime-cache"` | `"cloudflare"`, `"vercel"` |
| Database `driver: "d1"` | `"cloudflare"` |
| Workspace Store `"cloudflare-artifacts"`, `"vercel-blob"` | `"cloudflare"`, `"vercel"` |

It rewrites the options object of `vitehub()`, framework config helpers (also under `vitehub`), the `hub*()` plugins, `createQueueClient()`, `createEmail()`, and `createBrowser()`. Calls must use an import from the owning package, including an alias or a namespace import. The default config in a `nuxt.config` or `nitro.config` file can use its framework's global helper. Plain default config objects are supported too. Names with another declaration in the file stay unchanged, so check shadowed imports by hand.

Workspace `store` objects change only in Workspace config, `defineWorkspace()` or `hubWorkspace()` options, or the `workspace` option of `defineAgent()`. Unrelated objects and member methods stay unchanged. Blob and KV `stores` entries change too. A driver value that is not a string literal stays, and the report names it. Options that a variable or a helper builds stay as they are, so search for `provider` and `authority` after the run.

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

## `nuxt-better-auth`

The codemod moves a Nuxt app from `@nuxtjs/better-auth` to ViteHub Auth. It reads the app and its local layers (`layers/*` and relative `extends` paths):

- `server/auth.config.ts` becomes `server/auth.ts`, and `defineServerAuth()` becomes `defineAuth()` from `vite-hub/auth`. The Better Auth options stay. In a callback, `requestOrigin` stays and `runtimeConfig` becomes `useRuntimeConfig()` from `nitro/runtime-config`. When the app has a Database, or a NuxtHub one, the codemod adds `database: authDatabase()`.
- `app/auth.config.ts` becomes `app/auth.client.ts`, and `defineClientAuth()` becomes `defineAuthClient()` from `vite-hub/auth/vue`. A config without options goes away.
- A supported route rule with `auth` becomes `definePageMeta({ auth })` on each page it matches. A page that sets supported `auth` meta keeps it. Signed-in API rules become `access.routes` entries. Exact public exceptions and the Auth endpoints stay outside the generated API guard.
- `auth.redirects.login` and `auth.redirects.guest` become `access.signIn` and `access.afterSignIn` in `server/auth.ts`.
- In server code, `serverAuth(event)` becomes `useAuth(event)` and `requireUserSession(event)` becomes `requireAuth(event)`. Optional session reads use Better Auth's `getSession()` and forward its session cookies.
- `package.json` loses `@nuxtjs/better-auth` and gets `vite-hub`, `@vite-hub/auth`, and `better-auth` `^1.7.15`.

The codemod stops without editing Auth when it cannot preserve the source policy. For example, it stops on user-field checks, overlapping page rules, path-dependent page rules, guest-only API rules, and computed route redirects. It checks nested local layers. It stops for Nuxt environment overrides such as `$production` or `$env`, `extends` overrides, and `extends` entries it cannot inspect. It also stops when ViteHub Auth is disabled or the source configs cannot move to Definitions that ViteHub can load.

The report lists manual changes for `requireUserSession()` with options, client composables such as `useSignIn()` and `fetchSession()`, unsupported module options and helpers, `#nuxt-better-auth` types, and `NUXT_BETTER_AUTH_SECRET` in env files.

```sh
npx @vite-hub/codemods nuxt-better-auth [dir] [--dry-run]
```

## `docus`

The codemod moves a site that extends the `docus` layer to `@vite-hub/docs`:

- `extends: ['docus']` goes, and `@vite-hub/docs/nuxt` joins `modules`. `site.name`, `site.url`, `llms.domain`, and the app config `seo`, `github`, and `socials` become `docs.site`, `docs.github`, and `docs.socials`.
- Files in `content/` lose the `1.` order prefix of Nuxt Content, and the order goes to `navigation.order`, or `order` in the folder's `.navigation.yml`. Page URLs stay the same.
- Frontmatter keeps only the fields that `@vite-hub/docs` reads, because another field fails its build. `seo.ogImage` becomes `seo.image`, `navigation.icon` becomes `icon`, and a page without `title` takes its first `# Heading`. `::callout` becomes `::note`.
- `package.json` loses `docus`, `@nuxt/content`, and `better-sqlite3`, and gets `@vite-hub/docs` and its peers.

The report lists what it does not move: Nuxt UI page components in Markdown, such as `::u-page-hero`, Vue components in `components/content/`, frontmatter fields such as `links`, and the app config keys and Docus module options without an equivalent.

The codemod stops without changing files if a destination is occupied, custom collections or extra Markdown could change the published pages, or it cannot preserve routes, local Markdown file links, or computed settings. Resolve the reported issue before migrating.

```sh
npx @vite-hub/codemods docus [dir] [--dry-run]
```

## `nuxt-content`

The codemod moves the collections of `content.config.ts` to `server/content.ts`. Each collection becomes a `glob()` Source with the same files and paths, and a `schema` goes through `contentSource()`. `source.prefix` and `source.exclude` keep their paths. `z` from `@nuxt/content` becomes `z` from `zod`. Content serves the Sources with `access: 'public'`, as Nuxt Content did. `@nuxt/content` becomes `vite-hub/nuxt`, and `package.json` gets `vite-hub` and `@vite-hub/content`.

The report lists `queryCollection()` reads and `<ContentRenderer>`, because ViteHub Content reads with `content.get(path)` and `content.list()`. It also flags data collections, which need the `json()` or `yaml()` plugin, and the `content` options of `nuxt.config`. The codemod stops without changing files if any collection has a Source or schema it cannot translate safely, such as a remote `source.repository`, an exclusion it cannot rebase, or a schema that refers to a local declaration. A Docus site moves with `docus` instead.

```sh
npx @vite-hub/codemods nuxt-content [dir] [--dry-run]
```

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

## `shell-driver`

Shell now uses `driver` for the key that selects its backend, like Browser and the other primitives:

| Old | New |
| --- | --- |
| `createShellRuntime({ provider })` | `createShellRuntime({ driver })` |
| `ShellExecutionProvider` from `vite-hub/shell` | `ShellDriver` |
| `createJustBashProvider()` and `JustBashProviderOptions` from `vite-hub/shell/providers/just-bash` | `createJustBashDriver()` and `JustBashDriverOptions` |
| `createWorkspaceTools(workspace, { executionProvider })` | `createWorkspaceTools(workspace, { shellDriver })` |

```diff
 import { createShellRuntime } from "vite-hub/shell"
-import { createJustBashProvider } from "vite-hub/shell/providers/just-bash"
+import { createJustBashDriver } from "vite-hub/shell/providers/just-bash"

 export const shell = createShellRuntime({
-  provider: createJustBashProvider({ commands: ["ls", "cat"], fs }),
+  driver: createJustBashDriver({ commands: ["ls", "cat"], fs }),
 })
```

The same renames apply to the `@vite-hub/*` paths, to namespace imports, and to `const { createJustBashProvider } = await import(...)`. The codemod changes only calls of the imported `createShellRuntime()` and `createWorkspaceTools()`, so a `provider` key of another API stays. The report lists a call whose options it cannot see, such as a variable or a spread object.

```sh
npx @vite-hub/codemods shell-driver [dir] [--dry-run]
```

## `access-spellings`

Public access has one spelling, `access: "public"`, and sign-in has one, `authorize`:

| Old | New |
| --- | --- |
| `defineRealtime({ auth: true })` | `defineRealtime({ authorize: true })` |
| `defineRealtime({ auth: false, authorize })` | `defineRealtime({ authorize })` |
| `public: true` on `defineMcpTool()`, `defineMcpPrompt()`, and `defineMcpResource()` | `access: "public"` |
| `public: false` on an MCP definition | removed |

The codemod also changes default-export objects in `server/realtime/` and `server/mcp/`, and `defineRealtime()` without an import, as Nuxt auto-imports it. A Realtime definition with both `auth: true` and `authorize()` stays, and the report lists it: `authorize()` now also runs for signed-out callers, with `user: null`, so remove `auth` and return `false` when `user` is `null`.

```sh
npx @vite-hub/codemods access-spellings [dir] [--dry-run]
```

## `auth-sign-in`

The sign-in pages of Auth are in one place, `access` of `server/auth.ts`:

| Old | New |
| --- | --- |
| `vitehub({ auth: { redirects: { login: '/login' } } })` | `defineAuth({ access: { signIn: '/login' } })` |
| `vitehub({ auth: { redirects: { guest: '/app' } } })` | `defineAuth({ access: { afterSignIn: '/app' } })` |
| `access: { signIn: { provider: 'github', callbackURL: '/app' } }` | `access: { signIn: { provider: 'github' }, afterSignIn: '/app' }` |

If a redirect cannot be migrated safely, the codemod leaves the files unchanged and reports what to move by hand. This covers conflicting overrides, destinations that are not literal app paths, dynamic Definition options, and a `redirects.login` page next to a provider in `access.signIn`.

```sh
npx @vite-hub/codemods auth-sign-in [dir] [--dry-run]
```

## `channels`

`http()` is removed. Use `webhook()` from `vite-hub/channels` for an HTTP sender. Use `channelAdapter("http", options)` from `vite-hub/agent/channels` to keep the Channel kind and State.

The codemod rewrites direct calls without options or with a literal Boolean `route` option. Import paths stay the same. The report flags references, typed or complex calls, namespace imports, dynamic loads, re-exports of `http`, and mocks for manual review. To preserve the kind on a typed route, use `channelAdapter("http", options)` and type callback parameters explicitly. Use `webChat()` only if changing the kind is acceptable.

It also moves webhook secrets and signatures to the names of Webhooks:

| Old | New |
| --- | --- |
| `secretToken: process.env.X` in a `webhooks` registration | `secret: "X"` |
| `secretToken: () => …` in a `webhooks` registration | `secret: () => …` |
| `secret: process.env.X` in `webhook()` or `stripe()` | `secret: "X"` |
| `signature: "github-sha256"` or `"stripe-sha256"` | `signature: "github"` or `"stripe"` |
| `signature: { preset: "hmac-sha256", … }` | `signature: { type: "hmac-sha256", … }` |
| `{ preset: "stripe-sha256", toleranceSeconds: 600 }`, `stripe({ toleranceSeconds: 600 })` | `{ type: "stripe", tolerance: "600s" }`, `stripe({ tolerance: "600s" })` |

A string `secret` is the name of the server variable that holds the secret, in `webhook()`, `stripe()`, and every `webhooks` registration of `channelAdapter()`, `defineChannelTrigger()`, and the chat adapters. A direct read like `useServerEnv().github.webhookSecret` moves into a function. Existing resolvers stay intact. The report lists expressions the codemod cannot classify, `secretToken` strings, and possible hard-coded secrets on `stripe()` or with an old signature. Move hard-coded secrets to server variables and set `secret` to the variable name.

```sh
npx @vite-hub/codemods channels [dir] [--dry-run]
```

## `auth-accessors`

Auth has one server accessor, `useAuth(event?)`:

| Old | New |
| --- | --- |
| `auth` from `vite-hub/auth/server` | `useAuth()` |
| `getAuth()` from `vite-hub/auth/server` | `useAuth()` |
| `await isGitHubOrgMember(token, 'acme')` from `vite-hub/auth` | `(!(await checkGitHubOrgMember(token, 'acme'))[0])` |

The codemod also changes named imports from `#vitehub/auth/server`. It reports possible `auth` and `getAuth()` auto-imports in `server/` without editing them, because those names can come from your app. `useAuth()` without an event reads the app's Auth Definition, as before. In a route, pass the event yourself: `useAuth(event)`. The report lists `useSession()` imports and possible app auto-imports, because `useUserSession()` names its refs differently. The codemod leaves membership imports unchanged if a call is not awaited or the organization may be empty.

```sh
npx @vite-hub/codemods auth-accessors [dir] [--dry-run]
```

## Check real apps

`test/real-world/projects.json` pins open source Nuxt apps that use the supported modules. The runner clones each app outside the repository, installs it when its codemod loads app code, runs the migration, and checks which codemods ran and what the report says:

```sh
corepack pnpm exec vp run -t @vite-hub/codemods#build
node packages/codemods/test/real-world/run.mjs [--build] [id...]
```

With `--build`, it also moves each app that has a `build` entry to Nuxt 5 nightly with the local `vite-hub` checkout, builds it, starts the server, and checks the probes. Set `VITEHUB_REAL_WORLD_DIR` to choose where the apps go.

## `tsconfig-paths`

ViteHub types the `#vitehub/*` aliases itself, in `.vitehub/types/`. Older apps mapped them by hand in `tsconfig.json`, for example `"#vitehub/emails/*": ["./.vitehub/email/templates/*"]`. `tsconfig-paths` removes each `#vitehub/*` entry of `compilerOptions.paths` whose targets are all inside `.vitehub/` or `.nuxt/`. When no entry is left, it removes `paths` too, so the paths of an extended config, such as `.nuxt/tsconfig.json`, apply again. It keeps comments and the other entries. The report lists `#vitehub/*` entries that point at the app's own files, such as a test stub.

```sh
npx @vite-hub/codemods tsconfig-paths [dir] [--dry-run]
```

## `workspace-repo`

`workspace-repo` renames the `repository` option of a GitHub Workspace Store to `repo`, the one spelling that the Store reads:

```sh
npx @vite-hub/codemods workspace-repo [dir] [--dry-run]
```

```diff [server/workspaces/handbook.ts]
 export default defineWorkspace({
   store: {
     driver: 'github',
-    repository: 'acme/handbook',
+    repo: 'acme/handbook',
   },
 })
```

The codemod changes inline GitHub Stores in `defineWorkspace()` and `vitehub()` calls. If a Store sets both keys or uses spreads or computed keys, the report asks you to move the previously effective repository to `repo` by hand. Migrate separately declared Store options by hand as well. The Workspace `fetch()` Source is now `url()`; `renamed-apis` updates imports while keeping their local names.

## Add a codemod

A codemod is a `Codemod` object with a `name`, a one-line `description`, a `detect()` function that tells whether the app uses what it migrates, and a `run()` function that returns planned edits and follow-ups. `run()` must not write files; the runner writes them, or prints them in a dry run. Add the codemod to `src/registry.ts`; the order there is the order in which the migration runs codemods. A codemod that moves an app from an older ViteHub API also goes in `upgradeCodemods`, so `vitehub migrate` runs it. Shared `nuxt.config` and `package.json` helpers live in `src/shared`.

```ts
import { runCodemod, formatReport } from "@vite-hub/codemods"

const run = await runCodemod("nuxt-safe-runtime-config", { cwd: "./app", dryRun: true })
console.log(formatReport(run))
```
