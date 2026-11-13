---
title: Operations
description: Define an ability once and call it from the Console, the CLI, and agent tools.
navigation.order: 32.1
navigation.group: Local tools
icon: i-lucide-square-function
---

An operation is a named action of your app, such as `content.publish` or `invocations.list`. Define it once with `defineOperation()`, and the Console, the `vitehub` CLI, and agent tools all call that one definition.

| Surface | How it calls the operation |
| --- | --- |
| Console | Sends one birpc call, `{ m: operation, a: [input] }`, to `POST /_vitehub/rpc`. See [Call format](/docs/development/console#call-format). |
| CLI | `vitehub <namespace> <command>` sends the same request. |
| Agent | The `operations()` capability turns the operation into a tool. |

## Define an operation

```ts [src/operations.ts] fragment
import * as v from 'valibot'
import { defineOperation } from 'vite-hub/operations'

export const reportOperations = [
  defineOperation({
    name: 'reports.list',
    description: 'List the reports of a team, newest first.',
    section: 'reports',
    kind: 'read',
    input: v.object({
      team: v.string(),
      limit: v.optional(v.pipe(v.number(), v.integer())),
    }),
    cli: { positional: ['team'] },
    run: async ({ team, limit }, { user }) => {
      return await listReports(team, { limit: limit ?? 20, viewer: user?.id })
    },
  }),
]
```

| Field | Meaning |
| --- | --- |
| `name` | `<section>.<verb>`, in lower case. It is unique in the app. |
| `description` | One sentence. It is the CLI help line and the tool description. |
| `section` | The Console section that grants access, such as `content`. `false` lets any Console user call it. A function reads the section from the input. |
| `kind` | `read` never changes state. `write` changes state. `destructive` deletes or publishes. |
| `input` | A Standard Schema. This repository uses Valibot. Its JSON Schema makes the CLI options and the tool input. |
| `output` | Optional. A Standard Schema of the result. |
| `cli` | Optional. `namespace` and `command` rename the command. `positional` lists input keys passed without a flag. `default: true` makes `vitehub <namespace>` run it when no command is named. `format` prints a readable result. Without it the CLI prints JSON. |
| `maxRequestBytes` | Optional. Raises the 64 KiB request limit for large inputs. A value below 64 KiB fails with `INTERNAL_R0020`. |
| `mcp` | Optional. `false` keeps the operation out of MCP. `{ title, format }` sets the short title that MCP clients show, and `format(output)` the text that the Agent reads. The result stays the structured content. Without `format`, the text is the result as JSON. |
| `readOnlyWhen` | Optional. `(input) => boolean`. Returns true for a call that only reads, such as a dry run of a `destructive` operation. The CLI then skips confirmation, and an agent runs it without approval. Without it, every `destructive` call asks. |
| `user` | Optional. `false` tells the Console that `run` never reads `context.user`, so it skips the session lookup. |
| `run` | Does the work. It gets the checked input and the context. |

`run` gets this context:

```ts
import type { OperationAccess, OperationActor, OperationUser } from 'vite-hub/operations'

interface OperationContext {
  access: OperationAccess // the checked Console access of the call
  user: OperationUser | null // the signed-in user
  actor?: OperationActor // the Agent Invoker, when an agent calls for `user`
  surface: 'console' | 'cli' | 'mcp' | 'agent'
  env?: Record<string, unknown>
  waitUntil?: (task: Promise<unknown>) => void
  request?: Request
  overrideLeases?: boolean // an Agent may pass `lease: "override"` to `content.save`, `content.remove`, and `content.restore`
}
```

An operation with `invoke: true` runs app code: `workflow.start`, `workflow.resume`, `queue.send`, `task.run`, `schedule.run`, and `schedule.start`. The Console registers it only when `console.invoke` is on. That is the default in development, and off in a production build. With `console.invoke` off, the operation does not exist for the Console RPC, the CLI with `--url`, agent tools, and MCP, whatever `console.authorize` grants. `task.run` is `destructive`, so the CLI asks for `--yes` and agents need approval. `cli.dispatch` names a route that takes a signed dispatch, so `schedule run --url` can run with a dispatch key and no Console credentials.

The generated commands call the Console RPC. `vitehub()` installs it. Standalone `hubKV()`, `hubBlob()`, `hubEmail()`, and `hubRateLimit()` install a local development RPC for their storage commands. Other standalone plugins, such as `hubWorkflow()`, need a running app with an operation RPC.

`console.authorize` grants a section as `'kv'` (every operation) or `'kv:read'` (only `kind: 'read'` operations and calls that `readOnlyWhen` marks as reads). The check runs once, in the shared access path, so the Console RPC, the CLI with `--url`, agent tools, and MCP agree. An operation that both reads and writes under one name, such as `documents.action`, sets `readOnlyWhen` so a read-only role keeps its reads.

Check your own package's policy inside `run`. The section check only decides who can reach the operation. For example, `content.*` operations call `content.can()` for each document.

## Contribute it

A Vite plugin adds operations through its metadata. `vite-hub` collects them from every plugin and installs them in the Console server plugin.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
const reports = {
  name: 'reports',
  vitehub: {
    operations: [{ module: 'my-app/operations', export: 'reportOperations' }],
  },
}

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node' },
  vite: {
    plugins: [reports],
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

const reports = {
  name: 'reports',
  vitehub: {
    operations: [{ module: 'my-app/operations', export: 'reportOperations' }],
  },
}

export default defineConfig({ plugins: [vitehub({ host: 'node' }), nitro(), reports] })
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import type { OperationContributingPlugin } from 'vite-hub/operations'

const reports = {
  name: 'reports',
  vitehub: {
    operations: [{ module: 'my-app/operations', export: 'reportOperations' }],
  },
} satisfies OperationContributingPlugin

export default defineConfig({ plugins: [vitehub({ host: 'node' }), reports] })
```
:::
::

A library that does not install `vite-hub` imports `defineOperation` and the same types from `@vite-hub/runtime/operations`.

The module is the specifier that your app can import. The export is one operation or a list of them. Two operations with the same name fail the build with `INTERNAL_B0048`, and the message names both plugins.

Run `vitehub inspect definitions --kind operation` to list the app's operations.

## Call it

```bash [Terminal]
pnpm vitehub reports list acme --limit 5
pnpm vitehub reports list --help
pnpm vitehub reports list acme --url https://app.example.com --json
```

See [Run any operation](/docs/development/cli#run-any-operation) for `--json`, `--yes`, `--url`, and credentials. A `kind: 'destructive'` operation asks for confirmation, or needs `--yes`.

Confirmation uses the schema's defaults and transforms. If the server parses the input as destructive after the CLI treated it as a read, the call fails with `INTERNAL_R0026`. Check the call and run it again with `--yes`.

Each input schema key becomes a flag. `url`, `timeout`, `json`, `yes`, and `input` are reserved for the CLI, and using one fails with `INTERNAL_R0020`. Two operations that map to the same `vitehub <namespace> <command>` fail the build with `INTERNAL_B0049`. Set `cli.namespace` or `cli.command` on one of them.

To let an agent call operations, add the capability:

```ts [server/agents/editor.ts]
import { defineAgent } from 'vite-hub/agent'
import { operations } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [operations({ include: ['reports.*'], approve: 'write' })],
})
```

Each operation becomes a tool with dots as underscores: `reports.list` is `reports_list`. Channel conversations are private. An Agent reads them only with `operations({ conversations: 'participant' | 'all' })`, as [Who can read a conversation](/docs/agents/channels#who-can-read-a-conversation) describes.

`approve` sets which operations wait for approval: `'write'` (the default: write and destructive operations wait), `'destructive'`, `'all'`, `'never'`, a list of names, or a function. A call that `readOnlyWhen` marks as a read never waits.

The agent acts for the Auth user its Invoker stands for (`auth.user(invoker)`, or the `user` option), so `context.user` and `context.actor` are set. The capability runs `console.authorize` for that user, with a request without headers, and offers only operations in allowed sections. A read-only grant (`'<section>:read'`) offers only reads and `readOnlyWhen` dry runs, and the run still refuses a write.

::warning
Without `console.authorize`, nothing filters by section, and `include` is the only gate. List only what the agent may do.
::

`content.save`, `content.remove`, and `content.restore` reject `lease: 'override'` from an agent or MCP client, unless you create the capability with `operations({ overrideLeases: true })`. When a person holds the lease, the error names them and tells the model to wait, not how to override.

The server installs the operation registry at start, so the tools need no earlier RPC call.

## Errors

An operation fails by throwing an error with these fields:

| Field | Meaning |
| --- | --- |
| `code` | A stable code, such as `CONTENT_FORBIDDEN`. |
| `message` | What went wrong. |
| `fix` | What to do. Optional. |
| `docs` | A link. Optional. |
| `details` | JSON for a program, such as per-field issues. Kept for status below 500. |
| `status` | An HTTP status from 400 to 599. Defaults to 500. |

Every surface reports the same fields. The RPC answers `{ ok: false, code, message, fix, status }`. The CLI prints the code, message, and fix on stderr, and exits with `1`. An agent tool returns `{ ok: false, error }` for a status below 500, so the model can act on it.

Core error codes:

| Code | When |
| --- | --- |
| `INTERNAL_R0020` | The definition is not valid: a bad name, a reserved input key, a `maxRequestBytes` below 64 KiB. |
| `INTERNAL_R0021` | The app has no operation with that name. |
| `INTERNAL_R0022` | The input does not match the schema. The message lists the fields. |
| `INTERNAL_R0023` | The access lacks the operation's section, or only reads it (`'<section>:read'`) and the call writes. |
| `INTERNAL_R0024` | The CLI could not reach the app. |
| `INTERNAL_R0025` | A dev server answered for another project. |
| `INTERNAL_R0026` | The server parsed a destructive call that the generated CLI command did not confirm. Review the call and pass `--yes`. |
| `INTERNAL_B0048` | Two operations have the same name. |
| `INTERNAL_B0049` | Two operations are the same CLI command. |
| `INTERNAL_B0050` | Two operations are the same [MCP](/docs/development/mcp) tool name, such as `content.publish` and `content_publish`. |

## Access

The RPC checks the section with `console.authorize` before it runs the operation. A call outside the allowed sections gets `403`. In a build, the RPC route exists when `console` is set, and takes only [signed requests](/docs/development/console#sign-console-requests).

In `vite dev` without a `console` option, the app serves the RPC with the local policy, so every section is open. It answers only this machine, so the `vitehub` commands can call it without a signature. `console: false` turns this RPC off.

::warning
A dev RPC without signed calls (`local` access, or `console: { auth: false }`) answers only loopback requests. The `Host` header must be `localhost`, `127.0.0.1`, or `[::1]`, and so must the peer address, when the host exposes it. Other requests get `403` with `CONSOLE_LOOPBACK_ONLY`. To share the dev server with other people, remove `console.auth`, so it takes only signed calls.
::

In `vite dev`, a call without a signed user runs as `context.user = { id: 'local', name: 'You' }`. The RPC builds the context in one place, so Comments and Content see the same user. A build never adds it: a production call from the CLI has `context.user` unset, and a call from the Console has the person that the Console signed.

Duplicate operation names fail every build, also without a `console` option. An app without `server/content.ts` has no Content operations.

## Built-in operations

| Package | Operations |
| --- | --- |
| `vite-hub` (Console sections) | `agents.list`, `agents.invoke`, `invocations.list`, `invocations.get`, `invocations.cancel`, `invocations.delete`, `invocations.workspace`, `invocations.capabilities`, `databases.browse`, `databases.tables`, `definitions.list`, `env.get`, `project.get`, `search.query`, `sections.list`, `status.get`, `usage.get`, `documents.action`, `media.action` |
| [Blob](/docs/development/cli#read-and-write-blobs) | `blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.delete`, `blob.media`, `blob.variants` |
| [KV](/docs/development/cli#read-and-write-kv-keys) | `kv.list`, `kv.get`, `kv.has`, `kv.set`, `kv.delete` |
| [Cache](/docs/development/cli#read-and-invalidate-the-cache) (`cache` option) | `cache.list`, `cache.get`, `cache.delete` |
| [Email](/docs/development/cli#inspect-the-email-development-outbox) | `email.outbox-list`, `email.outbox-show`, `email.outbox-clear`, `email.preview` |
| [Rate Limit](/docs/development/cli#read-and-reset-rate-limit-counters) | `rate-limit.peek`, `rate-limit.reset` |
| Task plugin (`tasks` section) | `task.list`, `task.run` |
| [Queue](/docs/queue) (Queues section) | `queue.list`, `queue.send` |
| [Content](/docs/content/cli) | `content.collections`, `content.list`, `content.resolve`, `content.show`, `content.status`, `content.diff`, `content.revisions`, `content.save`, `content.remove`, `content.restore`, `content.publish`, `content.schedule`, `content.unschedule`, `content.schedules`, `content.sitemap`, `content.previews` |
| [Workflow](/docs/workflows) (Workflows section) | `workflow.start`, `workflow.get`, `workflow.cancel`, `workflow.resume`, `workflow.runs-list`, `workflow.runs-show`, `workflow.runs-clear` (development only) |
| [Schedule](/docs/schedule) (Schedules section) | `schedule.runs`, `schedule.attempts`, `schedule.run`, `schedule.list`, `schedule.start`, `schedule.cancel` |
| [Workspace](/docs/workspace) (Workspaces section) | `workspace.history`, `workspace.refs`, `workspace.show` |

- `blob.put`, `blob.delete`, `kv.set`, and `kv.delete` change data, and the Blob and KV sections of the Console run them. A role with `'blob'` or `'kv'` can write. Grant `'blob:read'` or `'kv:read'` for a read-only role (see [Limit a user to some sections](/docs/development/console#limit-a-user-to-some-sections)).
- `databases.browse` and `databases.tables` run as `vitehub database rows` and `vitehub database tables`.
- `cache.list`, `cache.get`, and `cache.delete` exist only when the app sets `cache`. They run as `vitehub cache list`, `get`, and `delete`. `cache.delete` is destructive, so a role needs `'cache'`. `'cache:read'` lists and reads.
- The task operations exist only when the app has tasks. The Console shows no `tasks` section, and `console.authorize` grants it by name.
- Queue has no peek, because the provider-independent Queue contract cannot read a backlog.
- The Workspace operations read a Workspace's kept history and run as `vitehub workspace history`, `refs`, and `show`.
