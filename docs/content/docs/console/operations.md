---
title: Operations
description: Define one action of your app with defineOperation(), and run it as a Console action, a vitehub CLI command, an Agent tool, and an MCP tool.
navigation.order: 31
navigation.group: Agents and tools
icon: i-lucide-square-function
---

An **operation** is one named action of your app, such as `content.publish` or `invocations.list`. Define it once with `defineOperation()`, and every surface calls that same definition:

| Surface | How it calls the operation |
| --- | --- |
| Console | Sends one birpc call, `{ m: operation, a: [input] }`, to `POST /_vitehub/rpc`. See [Call format](#call-format). |
| CLI | `vitehub <namespace> <command>` sends the same request. |
| Agent | The `operations()` capability turns the operation into a tool. |
| MCP | `run_operation` of the [ViteHub MCP](/docs/console/mcp#project-tools) sends the same request, signed by the Console. |

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
| `name` | `<section>.<verb>` in lower case, unique in the app. |
| `description` | One sentence, used as the CLI help line and the tool description. |
| `section` | The Console section that grants access, such as `content`. `false` lets any Console user call it, and a function reads it from the input. |
| `kind` | `read` never changes state, `write` changes state, `destructive` deletes or publishes. |
| `input` | A Standard Schema, such as Valibot. Its JSON Schema makes the CLI options and the tool input. |
| `output` | Optional. A Standard Schema of the result. |
| `cli` | Optional. `namespace` and `command` rename the command, `positional` lists input keys passed without a flag, `default: true` runs it for a bare `vitehub <namespace>`, and `format` prints a readable result instead of JSON. |
| `maxRequestBytes` | Optional. Raises the 64 KiB request limit. A lower value fails with `INTERNAL_R0020`. |
| `mcp` | Optional. `false` keeps it out of MCP. `{ title, format }` sets the title that MCP clients show and, with `format(output)`, the text that the Agent reads instead of the JSON result. The structured content stays the result. |
| `readOnlyWhen` | Optional. `(input) => boolean`, true for a call that only reads, such as a dry run. The CLI then skips confirmation and an agent needs no approval. Without it, every `destructive` call asks. |
| `user` | Optional. `false` says that `run` never reads `context.user`, so the Console skips the session lookup. |
| `invoke` | Optional. `true` for an operation that runs app code, such as a workflow, a task or a schedule. |
| `run` | Does the work with the checked input and this context: |

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

Before `run`, the shared access path checks the section against [`console.authorize`](/docs/console/access), so every surface agrees, and a call outside the allowed sections gets `403`. A `'<section>:read'` grant allows only `read` operations and `readOnlyWhen` reads, so an operation that reads and writes under one name, such as `documents.action`, sets `readOnlyWhen` to keep its reads open. The section check only decides who reaches the operation: check your own policy inside `run`, as `content.*` does with `content.can()` for each document.

An `invoke: true` operation exists only while `console.invoke` is on, which is the default in development and off in a production build. With it off, no surface can call the operation, whatever `authorize` grants. The built-in ones are `workflow.start`, `workflow.resume`, `queue.send`, `task.run`, `schedule.run` and `schedule.start`.

## Contribute it

A Vite plugin adds operations through its `vitehub.operations` metadata, and `vite-hub` installs them from every plugin:

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


`module` is a specifier that your app can import, and `export` names one operation or a list. A library without `vite-hub` imports `defineOperation` and its types from `@vite-hub/runtime/operations`. Two operations with one name fail every build with `INTERNAL_B0048`, also without a `console` option, and the message names both plugins. `vitehub inspect definitions --kind operation` lists them all.

## Call it

```bash [Terminal]
pnpm vitehub reports list acme --limit 5
pnpm vitehub reports list --help
pnpm vitehub reports list acme --url https://app.example.com --json
```

Each input key becomes a flag, except the reserved `url`, `timeout`, `json`, `yes` and `input`, which fail with `INTERNAL_R0020`. Two operations on the same `vitehub <namespace> <command>` fail the build with `INTERNAL_B0049`, so rename one with `cli.namespace` or `cli.command`. See [Run any operation](/docs/cli/operations#run-any-operation) for `--json`, `--yes`, `--url` and credentials.

A `destructive` operation asks for confirmation, or needs `--yes`. The CLI applies the schema's defaults and transforms first, and if the server still parses a call as destructive that the CLI treated as a read, it fails with `INTERNAL_R0026`; check the call and pass `--yes`.

::note
The generated commands call the Console RPC that `vitehub()` installs. Standalone `hubKV()`, `hubBlob()`, `hubEmail()` and `hubRateLimit()` install a local development RPC for their storage commands, while other standalone plugins, such as `hubWorkflow()`, need a running app with an operation RPC.
::

To let an Agent call operations, add the capability:

```ts [server/agents/editor.ts]
import { defineAgent } from 'vite-hub/agent'
import { operations } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [operations({ include: ['reports.*'], approve: 'write' })],
})
```

Each operation becomes a tool with dots as underscores, so `reports.list` is `reports_list`. `approve` picks the calls that wait for approval: `'write'` (the default, for write and destructive operations), `'destructive'`, `'all'`, `'never'`, a list of names or a function. `readOnlyWhen` reads never wait.

The Agent acts for its Invoker's Auth user (`auth.user(invoker)`, or the `user` option), which sets `context.user` and `context.actor`. The capability runs `console.authorize` for that user, with a request without headers, and offers only operations in allowed sections, or only reads for a read-only grant.

::warning
Without `console.authorize`, nothing filters by section, and `include` is the only gate. List only what the Agent may do.
::

An Agent reads private Channel conversations only with `operations({ conversations: 'participant' | 'all' })`, as [Who can read a conversation](/docs/agents/channels#who-can-read-a-conversation) describes. `content.save`, `content.remove` and `content.restore` refuse `lease: 'override'` from an Agent or MCP client unless the capability sets `overrideLeases: true`, and when a person holds the lease, the error tells the model to wait.

## Errors

An operation fails by throwing an error with these fields:

| Field | Meaning |
| --- | --- |
| `code` | A stable code, such as `CONTENT_FORBIDDEN`. |
| `message` | What went wrong. |
| `fix` | What to do. Optional. |
| `docs` | A link. Optional. |
| `details` | JSON for a program, such as per-field issues. Kept for a status below 500. |
| `status` | An HTTP status from 400 to 599. Defaults to 500. |

Every surface reports them. The RPC answers `{ ok: false, code, message, fix, status }`, the CLI prints the code, message and fix on stderr and exits with `1`, and an Agent tool returns `{ ok: false, error }` for a status below 500, so the model can act on it.

| Code | When |
| --- | --- |
| `INTERNAL_R0020` | The definition is not valid: a bad name, a reserved input key, or a `maxRequestBytes` below 64 KiB. |
| `INTERNAL_R0021` | The app has no operation with that name. |
| `INTERNAL_R0022` | The input does not match the schema. The message lists the fields. |
| `INTERNAL_R0023` | The access lacks the operation's section, or only reads it (`'<section>:read'`) and the call writes. |
| `INTERNAL_R0024` | The CLI could not reach the app. |
| `INTERNAL_R0025` | A dev server answered for another project. |
| `INTERNAL_R0026` | The server parsed a destructive call that the generated CLI command did not confirm. Review the call and pass `--yes`. |
| `INTERNAL_B0048` | Two operations have the same name. |
| `INTERNAL_B0049` | Two operations are the same CLI command. |
| `INTERNAL_B0050` | Two operations are the same MCP tool name, such as `content.publish` and `content_publish`. |

## Call format

A `POST /_vitehub/rpc` request carries one birpc message as JSON: `m` is the operation, `a` holds its input, and the reply repeats the id `i`.

```json [Request]
{ "m": "sections.list", "a": [{}], "t": "q", "i": "V1StGXR8_Z5jdHi6B-myT" }
```

The reply holds the value in `r`, with HTTP status `200` or the one that the operation sets, such as `202`:

```json [Response]
{ "t": "s", "i": "V1StGXR8_Z5jdHi6B-myT", "r": { "sections": ["agents", "kv"] } }
```

A failure has `e` instead, with `code`, `message` and `status`, plus `fix`, `docs` or `details` when present, and never a stack. Its HTTP status matches `status`. A request that the endpoint cannot read, such as a body over the limit, gets a reply without `i`. Unknown names get `404` with `Console operation not found.` Each call is stateless, so a host such as Cloudflare Workers can route consecutive calls to different instances.

## Built-in operations

| Package | Operations |
| --- | --- |
| `vite-hub` (Console sections) | `agents.list`, `agents.invoke`, `invocations.list`, `invocations.get`, `invocations.cancel`, `invocations.undo`, `invocations.delete`, `invocations.workspace`, `invocations.capabilities`, `databases.browse`, `databases.tables`, `definitions.list`, `env.get`, `project.get`, `search.query`, `sections.list`, `status.get`, `usage.get`, `documents.action`, `media.action` |
| [Blob](/docs/cli/storage#read-and-write-blobs) | `blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.delete`, `blob.media`, `blob.variants` |
| [KV](/docs/cli/storage#read-and-write-kv-keys) | `kv.list`, `kv.get`, `kv.has`, `kv.set`, `kv.delete` |
| [Email](/docs/cli/env#inspect-the-email-development-outbox) | `email.outbox-list`, `email.outbox-show`, `email.outbox-clear`, `email.preview` |
| [Rate Limit](/docs/cli/storage#read-and-reset-rate-limit-counters) | `rate-limit.peek`, `rate-limit.reset` |
| Task plugin (`tasks` section) | `task.list`, `task.run` |
| [Queue](/docs/queue) (Queues section) | `queue.list`, `queue.send` |
| [Content](/docs/content/cli) | `content.collections`, `content.list`, `content.resolve`, `content.show`, `content.status`, `content.diff`, `content.revisions`, `content.save`, `content.remove`, `content.restore`, `content.publish`, `content.schedule`, `content.unschedule`, `content.schedules`, `content.sitemap`, `content.previews` |
| [Workflow](/docs/workflows) (Workflows section) | `workflow.start`, `workflow.get`, `workflow.cancel`, `workflow.resume`, `workflow.runs-list`, `workflow.runs-show`, `workflow.runs-clear` (development only) |
| [Schedule](/docs/schedule) (Schedules section) | `schedule.runs`, `schedule.attempts`, `schedule.run`, `schedule.list`, `schedule.start`, `schedule.cancel` |
| [Workspace](/docs/workspace) (Workspaces section) | `workspace.history`, `workspace.refs`, `workspace.show` |

`blob.put`, `blob.delete`, `kv.set` and `kv.delete` write, so a read-only role needs `'blob:read'` or `'kv:read'`. `databases.browse` and `databases.tables` run as `vitehub database rows` and `tables`, and the Workspace operations, which read kept history, as `vitehub workspace history`, `refs` and `show`. An app without `server/content.ts` has no Content operations.

The task operations exist only when the app has tasks, and `task.run` is `destructive`, so the CLI asks for `--yes` and Agents need approval. The Console shows no `tasks` section, but `authorize` can grant it by name. Queue has no peek, because the provider-independent Queue contract cannot read a backlog.
