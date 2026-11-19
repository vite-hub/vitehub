---
title: Upgrade to the current ViteHub API
description: The codemods that move an app from a former ViteHub API to the current one, what each rewrites, and what each leaves in the report.
navigation.title: Upgrade ViteHub
navigation.order: 3
icon: i-lucide-arrow-up-circle
---

ViteHub is early, and its public API still changes. When an API changes, a codemod moves your app, and a diagnostic or a [Vite Doctor rule](/docs/reference/doctor-rules) names that codemod. `vitehub migrate` runs every upgrade codemod that applies, in one run:

```bash [Terminal]
vitehub migrate [dir] [--dry-run]
```

It runs `vitehub-options`, `define-forms`, `runtime-contracts`, `root-accessors`, `one-entry-imports`, `queue-workflow-verbs`, `queue-durations`, `result-tuples`, `agent-surface`, `driver-key`, `renamed-apis`, `tsconfig-paths`, `shell-driver`, `access-spellings`, and `channels`, in that order, and each one sees the edits of the ones before it. Install `@vite-hub/codemods` as a development dependency first. Without the `vitehub` CLI, `npx @vite-hub/codemods [dir]` runs them too, with the codemods that move an app from other modules. To run one codemod, pass its name.

After the upgrade, run Vite Doctor. Rule [`VHUB0003`](/docs/reference/doctor-rules#vhub0003) finds Result calls, such as `await email.send(...)`, whose error the code drops.

## define-forms

ViteHub keeps one define form for each primitive. `define-forms` rewrites the former forms:

```bash [Terminal]
npx @vite-hub/codemods define-forms [dir] [--dry-run]
```

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

The report lists what it cannot change:

- Queue calls with spread arguments or options the codemod cannot safely flatten, such as shared options objects.
- Schedule options that are not an object literal. The codemod spreads them into the object.
- Sandbox Task options that are not an object literal.
- Workflow handlers with parameters that it cannot rewrite, such as a rest parameter.
- Referenced Workflow handlers. The codemod wraps a local handler when it can determine its parameters. It leaves other references and ambiguous `createWorkflow()` handlers for manual review.
- Workflow option expressions and spreads. Make the options explicit and remove the old `id` option.
- Dynamic imports of `server/content.ts`.
- Helper files left in `server/databases/` that the new discovery reads as Databases.
- Lines in `package.json` and host config files that name the former Database paths.

The former forms fail with `QUEUE_INVALID_DEFINITION`, `SCHEDULE_C0007`, `SANDBOX_TASK_C0014`, `WORKFLOW_C0015`, `SOURCE_B0009`, and [`DATABASE_LEGACY_CONFIG_FILE`](/docs/database/limits-and-errors#database_legacy_config_file). See [file conventions](/docs/reference/file-conventions).

## vitehub-options

`vitehub()` is the only place for config, and `logs` is part of `observability`. `vitehub-options` edits every `vite.config.*` and `nuxt.config.*` in the app:

```bash [Terminal]
npx @vite-hub/codemods vitehub-options [dir] [--dry-run]
```

| Old | New |
| --- | --- |
| `vitehub({ preset })`, `vitehub: { preset }` in `nuxt.config.ts` | `host` |
| `sandbox: true` | `sandboxTask: true` |
| `vitehub({ logs: true })` | `vitehub({ observability: { logs: true } })` |
| `logs: { evlog, source }` | `observability: { evlog, logs: { source } }` |
| `defineConfig({ env: { server }, plugins: [vitehub()] })` | `vitehub({ env: { server } })` |
| `defineConfig({ env, plugins: [hubEnv()] })` | `hubEnv({ ...declarations })` |
| `vite: { env }` in `nuxt.config.ts` | `env` in the `vite-hub/nuxt` options |
| A top-level Vite key such as `kv` or `blob` | `vitehub({ kv })`, or the argument of `hubKV()` |
| `devtools`, `contentImportBase` | removed |

The report lists what the codemod cannot move: `preset` next to `host`, `sandbox` options that are not a boolean, `cloudflare.secretsFile`, a `logs` or `env` value that is an expression, `env` set in two places, `vitehub({ env: false })` next to Env declarations, and source lines that name a renamed option type, such as `KVModuleOptions`, which is now `KVOptions`.

Sandbox Task option objects move like the other keys: into `vitehub({ sandboxTask })`, the `vite-hub/nuxt` options, or an existing `hubSandboxTask()` call without arguments.

Vite Doctor rule [`VHUB0031`](/docs/reference/doctor-rules#vhub0031) reports the same options.

## queue-workflow-verbs

ViteHub renamed the Queue and Workflow verbs, so that each one says what it does:

```bash [Terminal]
npx @vite-hub/codemods queue-workflow-verbs [dir] [--dry-run]
```

| Old | New |
| --- | --- |
| `runQueue()` | `sendQueue()` |
| `getQueue()` | `useQueue()` |
| `dynamicQueue.run()`, `dynamicQueue.get()` | `dynamicQueue.send()`, `dynamicQueue.use()` |
| `runWorkflow()` | `startWorkflow()` |
| `resumeWorkflowSignal()` | `resumeWorkflow()` |
| `.run()` of a handle from `createWorkflow()` | `.start()` |
| `WorkflowDeferOptions` | `WorkflowStartOptions` |

`deferWorkflow()` and the `defer()` method of a Workflow handle now return nothing, like `deferQueue()`. Where the code reads the result, for example to store the run id, the codemod calls `startWorkflow()` or `.start()` instead. These return the run as `deferWorkflow()` did. Where the code only awaits the call as a statement, the codemod removes the `await`.

The codemod reads imports from `vite-hub/queue`, `vite-hub/workflow`, and their `@vite-hub/*` forms, also namespace imports, re-exports, and `<script>` blocks of `.vue` files. Named re-exports keep their old public names as aliases, so the consumers of a barrel file keep working. The report lists:

- star and namespace re-exports, whose consumers need manual changes,
- object keys and strings with an old name, for example in a `vi.mock()` factory,
- Workflow handles that a file exports, because other files call their methods.

## queue-durations

Queue `delaySeconds` is now `delay`, and `retentionSeconds` is now `retention`. `delay` takes a duration string, such as `'60s'` or `'5m'`, as Workflow `delay` does. `retention` is a lifetime, so it takes a duration or a number of seconds, as KV `ttl` does:

```bash [Terminal]
npx @vite-hub/codemods queue-durations [dir] [--dry-run]
```

```diff [server/api/signup.post.ts]
-await sendQueue('welcome-email', { email }, { delaySeconds: 60, retentionSeconds: 3600 })
+await sendQueue('welcome-email', { email }, { delay: '60s', retention: 3600 })
```

The codemod changes the options of `sendQueue()`, `deferQueue()`, `dynamicQueue.send()`, `dynamicQueue.defer()`, and the `send()` and `sendBatch()` methods of a client from `useQueue()`, and the `{ retry: { delaySeconds } }` that `onError` of `defineQueue()` returns. It rewrites calls tied to explicit Queue imports. It reports unbound calls, including Nuxt auto-imports, without editing them because they can refer to app utilities. It turns a number, or arithmetic on numbers such as `24 * 60 * 60`, into the same time in seconds, such as `'86400s'`. It keeps `delaySeconds` in Cloudflare's native `message.retry()` and `batch.retryAll()`. The report lists:

- a `delay` value that is not a number in the code, such as a variable, which you write as a duration,
- `delaySeconds` and `retentionSeconds` that are left, such as options in a variable.

A send that still passes `delaySeconds` or `retentionSeconds` fails with `QUEUE_UNSUPPORTED_OPTION`, so a missed option does not send the job at once.

## result-tuples

`startWorkflow()`, `getWorkflowRun()`, `cancelWorkflow()`, `resumeWorkflow()`, and `runSchedule()` return `[error, data]` now, as `sendQueue()` does. They threw before. The `start()`, `getRun()`, and `cancel()` methods of a `createWorkflow()` handle changed in the same way. `result-tuples` reads each call as a Result that throws the error, so the code keeps its behavior:

```bash [Terminal]
npx @vite-hub/codemods result-tuples [dir] [--dry-run]
```

```diff [server/api/onboard.post.ts]
 export default defineEventHandler(async (event) => {
   const body = await readBody<{ email: string }>(event)
-  const run = await startWorkflow('onboard-user', body)
+  const [runError, run] = await startWorkflow('onboard-user', body)
+  if (runError) throw runError
   return { id: run.id }
 })
```

`return startWorkflow(...)` in an async function and a call in an `if` test move to a `const` before the statement. The codemod reads imports from `vite-hub/workflow`, `vite-hub/schedule`, and their `@vite-hub/*` forms. In Nuxt's `server/` directory, it also reads Workflow auto-imports. It only rewrites `runSchedule()` with a Schedule import, so it leaves app auto-imports with the same name alone. The report lists the calls that it cannot change, such as a call in a function that is not `async`, a call without `await`, or a handle that another file creates.

## one-entry-imports

ViteHub folded some subpaths into one entry per concept. `one-entry-imports` moves each import:

```bash [Terminal]
npx @vite-hub/codemods one-entry-imports [dir] [--dry-run]
```

| Old path | New path |
| --- | --- |
| `vite-hub/source/{file,files,github,glob,markdown}` | `vite-hub/source` |
| `vite-hub/env/{presets,provider,schema,secret,server}` | `vite-hub/env` |
| `vite-hub/env/{auth,http}` | `vite-hub/env/bridge` |
| `vite-hub/blob/{content-type,ensure,reference}` | `vite-hub/blob`, or `vite-hub/blob/client` for `content-type` in browser code |
| `vite-hub/browser/actions` | `vite-hub/browser` |
| `vite-hub/connections/http` | `vite-hub/connections` |
| `vite-hub/task` | `nitro/task`, and `nitro/types` for the task types |

The same moves apply to the `@vite-hub/*` paths. The codemod rewrites `import`, `export ... from`, `import()`, `import("...").Type`, `declare module`, and `vi.mock()` paths, and joins a moved import with an import of the new path in the same file.

For `blob/content-type`, only explicit server files use the Blob root. Browser, shared, and unclassified files use `blob/client`, which also works on the server.

The report lists strings that name an old path, such as aliases and test stubs, and `env/server` names that the Env root does not export, such as `runWithCloudflareEnv`. When an app moves to `nitro/task` and lists neither `nitro` nor `nuxt` in `package.json`, the report asks you to add `nitro`.

## agent-surface

`agent-surface` updates an app that imports `vite-hub/agent` or `@vite-hub/agent`, with or without Nuxt:

```bash [Terminal]
npx @vite-hub/codemods agent-surface [dir] [--dry-run]
```

- `AgentActor` and `AgentInvokerProfile` become `AgentInvoker`, `getAgentFromRegistry` becomes `loadAgent`, and `workflow` becomes `agentWorkflow`, in imports and in the code that reads them.
- `agent/process-host` and `agent/runtime/process` become `agent/process`. `agent/invocations/d1` and `agent/invocations/sqlite` become `agent/invocations`. `agent/state/sqlite` becomes `agent/state`. Two imports that land on the same entry merge into one.
- `defineAgent({ preset: "babysitter", presets: { babysitter } })` becomes `defineAgent({ extends: babysitter })`.
- `providers: { state: { provider } }` in Agent options (`vitehub({ agent })`, a `vitehub.agent` block, or `hubAgent()`) becomes `driver`. The same applies to `scheduler` and `sandbox`.
- `context: { actor }` in an Invocation input, `context.actor`, and a destructured `actor` next to other Agent context fields in a `defineAgent()` or `defineCapability()` callback become `invoker`.

The report lists what the codemod leaves: `getAgent()` and the root helpers that are no longer public, the private `agent/invocations/default` entry, a dynamic `preset` name, and an `actor` read that could also be another field, such as a GitHub sender.

## driver-key

`driver` is the only key that selects the backend of a resource. An old key fails with a `*_RENAMED_*_KEY` error that names `driver`. `driver-key` renames the old keys and the old driver names:

```bash [Terminal]
npx @vite-hub/codemods driver-key [dir] [--dry-run]
```

| Old | New |
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

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```diff [nuxt.config.ts]
 export default defineNuxtConfig({
   modules: ['vite-hub/nuxt'],
   vitehub: {
-    queue: { provider: 'cloudflare' },
-    kv: { driver: 'cloudflare-kv-binding' },
+    queue: { driver: 'cloudflare' },
+    kv: { driver: 'cloudflare' },
   },
 })
```
:::

:::tabs-item{label="Nitro"}
```diff [vite.config.ts]
 import { defineConfig } from 'vite'
 import { vitehub } from 'vite-hub'
 import { nitro } from 'nitro/vite'

 export default defineConfig({
   plugins: [
     vitehub({
-      queue: { provider: 'cloudflare' },
-      kv: { driver: 'cloudflare-kv-binding' },
+      queue: { driver: 'cloudflare' },
+      kv: { driver: 'cloudflare' },
     }),
     nitro(),
   ],
 })
```
:::

:::tabs-item{label="Vite"}
```diff [vite.config.ts]
 import { defineConfig } from 'vite'
 import { vitehub } from 'vite-hub'

 export default defineConfig({
   plugins: [
     vitehub({
-      queue: { provider: 'cloudflare' },
-      kv: { driver: 'cloudflare-kv-binding' },
+      queue: { driver: 'cloudflare' },
+      kv: { driver: 'cloudflare' },
     }),
   ],
 })
```
:::
::

It changes the options of `vitehub()`, the `vitehub` key of `nuxt.config` and `nitro.config`, the `hub*()` plugins, `createQueueClient()`, `createEmail()`, and `createBrowser()`. Workspace `store` objects change only in Workspace config, `defineWorkspace()`, `hubWorkspace()`, and the `workspace` option of `defineAgent()`. The report lists a driver value that is not a string literal. Options that a variable or a helper builds stay as they are, so search for `provider` and `authority` after the run.

## tsconfig-paths

ViteHub types the `#vitehub/*` aliases itself, in `.vitehub/types/`. Older apps mapped them by hand in `tsconfig.json`:

```bash [Terminal]
npx @vite-hub/codemods tsconfig-paths [dir] [--dry-run]
```

```diff [tsconfig.json]
 {
   "extends": "./.nuxt/tsconfig.json",
   "compilerOptions": {
     "paths": {
-      "#vitehub/emails/*": ["./.vitehub/email/templates/*"],
-      "#vitehub/env/server": ["./.vitehub/env/server.d.ts"],
       "~/utils/*": ["./utils/*"]
     }
   }
 }
```

The codemod removes each `#vitehub/*` entry whose targets are all inside `.vitehub/` or `.nuxt/`. When no entry is left, it removes `paths` too, so the paths of the extended config apply again. The report lists `#vitehub/*` entries that point at your own files, such as a test stub.

## shell-driver

`shell-driver` updates an app that uses Shell. Shell now uses `driver` for the key that selects its backend, like Browser and the other primitives:

```bash [Terminal]
npx @vite-hub/codemods shell-driver [dir] [--dry-run]
```

| Old | New |
| --- | --- |
| `createShellRuntime({ provider })` | `createShellRuntime({ driver })` |
| `ShellExecutionProvider` from `vite-hub/shell` | `ShellDriver` |
| `createJustBashProvider()` and `JustBashProviderOptions` from `vite-hub/shell/providers/just-bash` | `createJustBashDriver()` and `JustBashDriverOptions` |
| `createWorkspaceTools(workspace, { executionProvider })` | `createWorkspaceTools(workspace, { shellDriver })` |

```diff [server/utils/docs-shell.ts]
 import { createShellRuntime } from 'vite-hub/shell'
-import { createJustBashProvider } from 'vite-hub/shell/providers/just-bash'
+import { createJustBashDriver } from 'vite-hub/shell/providers/just-bash'

 export const shell = createShellRuntime({
-  provider: createJustBashProvider({ commands: ['ls', 'cat'], fs }),
+  driver: createJustBashDriver({ commands: ['ls', 'cat'], fs }),
 })
```

The same renames apply to the `@vite-hub/*` paths, to namespace imports, and to `const { createJustBashProvider } = await import(...)`. The codemod changes only calls of the imported `createShellRuntime()` and `createWorkspaceTools()`, so a `provider` key of another API stays. The report lists a call whose options it cannot see, such as a variable or a spread object.

## access-spellings

`access-spellings` updates the access keys of Realtime and MCP definitions. Public access has one spelling, `access: 'public'`, and sign-in has one, `authorize`:

```bash [Terminal]
npx @vite-hub/codemods access-spellings [dir] [--dry-run]
```

| Old | New |
| --- | --- |
| `defineRealtime({ auth: true })` | `defineRealtime({ authorize: true })` |
| `defineRealtime({ auth: false, authorize })` | `defineRealtime({ authorize })` |
| `public: true` on `defineMcpTool()`, `defineMcpPrompt()`, and `defineMcpResource()` | `access: 'public'` |
| `public: false` on an MCP definition | removed |

```diff [server/realtime/docs.ts]
 export default defineRealtime({
-  auth: true,
+  authorize: true,
   document: { workspace: 'docs' },
 })
```

The codemod also changes default-export objects in `server/realtime/` and `server/mcp/`, including nested definitions and object literals with `satisfies` or `as`. It recognizes `defineRealtime()` without an import, as Nuxt auto-imports it. An MCP server keeps its own `mcp.auth` option. If a spread, computed key, or competing rule makes the effective access unclear, the codemod leaves the definition unchanged and reports it for manual migration.

A Realtime definition with both `auth: true` and `authorize()` stays as it is, and the report lists it. `authorize()` now also runs for signed-out callers, with `user: null`, so remove `auth` and return `false` when `user` is `null`. Until then, the server rejects the definition with [`REALTIME_INVALID_ACCESS`](/docs/realtime/limits-and-errors#realtime_invalid_access).

If your browser app and Realtime API use different origins, keep the app origin in the Auth Definition's `trustedOrigins`. With no custom `identify()` or `origins()`, `authorize()` uses the same Auth origin check as `authorize: true`. Do not add `origins()` to pass the Auth session: an origin admitted by that hook does not get the session user.

## channels

`channels` replaces the removed Agent `http()` adapter. Use `webhook()` from `vite-hub/channels` for an HTTP sender. Use `channelAdapter("http", options)` from `vite-hub/agent/channels` to keep the Channel kind and State.

```bash [Terminal]
npx @vite-hub/codemods channels [dir] [--dry-run]
```

```diff [server/agents/support.ts]
-import { http, slack } from 'vite-hub/agent/channels'
+import { channelAdapter, slack } from 'vite-hub/agent/channels'

 export default defineAgent({
-  channels: { portal: http({ route: true }), slack: slack() },
+  channels: { portal: channelAdapter('http', { route: true }), slack: slack() },
 })
```

The codemod rewrites direct calls without options or with a literal Boolean `route` option. Import paths stay the same. The report flags references, typed or complex calls, namespace imports, dynamic loads, re-exports of `http`, and mocks for manual review. To preserve the kind on a typed route, use `channelAdapter("http", options)` and type callback parameters explicitly. Use `webChat()` only if changing the kind is acceptable.

It also moves webhook secrets and signatures to the names of [Webhooks](/docs/webhooks). A string `secret` is the name of the server variable that holds the secret, in `webhook()`, `stripe()`, and every `webhooks` registration of `channelAdapter()` and `defineChannelTrigger()`:

```diff [server/channels/portal.ts]
 webhooks: {
   secretHeader: 'x-hub-signature-256',
-  secretToken: process.env.GITHUB_WEBHOOK_SECRET,
-  signature: 'github-sha256',
+  secret: 'GITHUB_WEBHOOK_SECRET',
+  signature: 'github',
 },
```

| Old | New |
| --- | --- |
| `secretToken: process.env.X` | `secret: 'X'` |
| `secretToken: () => …` | `secret: () => …` |
| `'github-sha256'`, `'stripe-sha256'` | `'github'`, `'stripe'` |
| `{ preset: 'hmac-sha256', … }` | `{ type: 'hmac-sha256', … }` |
| `toleranceSeconds: 600` | `tolerance: '600s'` |

A direct Server Env read, such as `useServerEnv().github.webhookSecret`, moves into a function. Existing resolvers stay intact. The report lists expressions the codemod cannot classify and asks you to check secret strings on `stripe()` or with an old signature. Move any hard-coded secret to a server variable and set `secret` to its name. A `secretToken` string stays unchanged and the definition fails with `AGENT_WEBHOOK_OPTION_RENAMED` until you migrate it.
