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

It runs `vitehub-options`, `define-forms`, `runtime-contracts`, `root-accessors`, `one-entry-imports`, `queue-workflow-verbs`, `agent-surface`, `renamed-apis`, `tsconfig-paths`, and `shell-driver`, in that order, and each one sees the edits of the ones before it. Install `@vite-hub/codemods` as a development dependency first. Without the `vitehub` CLI, `npx @vite-hub/codemods [dir]` runs them too, with the codemods that move an app from other modules. To run one codemod, pass its name.

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
- Dynamic imports of `server/content.ts`.
- Helper files left in `server/databases/` that the new discovery reads as Databases.
- Lines in `package.json` and host config files that name the former Database paths.

The former forms fail with `QUEUE_INVALID_DEFINITION`, `SCHEDULE_C0007`, `SANDBOX_TASK_C0014`, `SOURCE_B0009`, and [`DATABASE_LEGACY_CONFIG_FILE`](/docs/database/limits-and-errors#database_legacy_config_file). See [file conventions](/docs/reference/file-conventions).

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
