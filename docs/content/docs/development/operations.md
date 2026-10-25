---
title: Operations
description: Define an ability once and call it from the Console, the CLI, and agent tools.
navigation.order: 32.1
navigation.group: Local tools
icon: i-lucide-square-function
---

An operation is a named ability of your app, such as `content.publish` or `invocations.list`. You define it once with `defineOperation()`. The Console, the `vitehub` CLI, and agent tools call that one definition. They do not each carry their own copy.

| Surface | How it calls the operation |
| --- | --- |
| Console | Sends `{ operation, input }` to `POST /_vitehub/rpc/__call`. |
| CLI | `vitehub <namespace> <command>` sends the same request. |
| Agent | The `operations()` capability turns the operation into a tool. |

## Define an operation

```ts [src/operations.ts]
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
| `input` | A Standard Schema. Valibot is the schema library of this repository. Its JSON Schema makes the CLI options and the tool input. |
| `output` | Optional. A Standard Schema of the result. |
| `cli` | Optional. `namespace` and `command` rename the command. `positional` lists the input keys that you pass without a flag. `format` prints a human result; without it the CLI prints JSON. |
| `maxRequestBytes` | Optional. Raises the 64 KiB request limit for large inputs. A value below 64 KiB fails with `INTERNAL_R0020`. |
| `readOnlyWhen` | Optional. `(input) => boolean`. Returns true for a call that only reads, such as a dry run of a `destructive` operation. The CLI then skips the confirmation and an agent runs it without approval. Without it, every call of a `destructive` operation asks. |
| `user` | Optional. `false` tells the Console that `run` never reads `context.user`, so it skips the session lookup. |
| `run` | Does the work. It gets the checked input and the context. |

`run` gets a context with these fields:

```ts
interface OperationContext {
  access: OperationAccess // the checked Console access of the call
  user: OperationUser | null // the signed-in user
  actor?: OperationActor // the Agent Actor, when an agent calls for `user`
  surface: 'console' | 'cli' | 'mcp' | 'agent'
  env?: Record<string, unknown>
  waitUntil?: (task: Promise<unknown>) => void
  request?: Request
  overrideLeases?: boolean // an Agent may pass `lease: "override"` to `content.save`
}
```

`console.authorize` grants a section as `'kv'` (every operation) or `'kv:read'` (only `kind: 'read'` operations and calls that `readOnlyWhen` marks as read only). The check runs once, in the shared access path, so the Console RPC, the CLI with `--url`, agent tools, and MCP agree. An operation that serves both reads and writes under one name, such as `documents.action`, sets `readOnlyWhen` so a read-only role keeps its reads.

Check the policy of your own package inside `run`. The section check only decides who may reach the operation. `content.*` operations, for example, call `content.can()` for each document.

## Contribute it

A Vite plugin contributes operations through its metadata. `vite-hub` collects them from every plugin and installs them in the Console server plugin.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

const reports = {
  name: 'reports',
  vitehub: {
    operations: [{ module: 'my-app/operations', export: 'reportOperations' }],
  },
}

export default defineConfig({ plugins: [vitehub(), reports] })
```

The module is the specifier that your app can import. The export is one operation or a list of them. Two operations with the same name fail the build with `INTERNAL_B0048`, and the message names both plugins.

Run `vitehub inspect definitions --kind operation` to list what the app has.

## Call it

```bash [Terminal]
pnpm vitehub reports list acme --limit 5
pnpm vitehub reports list --help
pnpm vitehub reports list acme --url https://app.example.com --json
```

See [Run any operation](/docs/development/cli#run-any-operation) for `--json`, `--yes`, `--url`, and the credentials. An operation of `kind: 'destructive'` asks for confirmation, or needs `--yes`.

A flag is made from each key of the input schema. The keys `url`, `timeout`, `json`, `yes`, and `input` are reserved for the CLI, and defining one fails with `INTERNAL_R0020`. Two operations that map to the same `vitehub <namespace> <command>` fail the build with `INTERNAL_B0049`; set `cli.namespace` or `cli.command` on one of them.

To call an operation from an agent, add the capability:

```ts [server/agents/editor.ts]
import { operations } from 'vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [operations({ include: ['reports.*'], approve: 'write' })],
})
```

Each operation becomes a tool named after it, with dots as underscores: `reports.list` is `reports_list`. `approve` says which operations wait for approval: `'write'` (the default: write and destructive operations wait), `'destructive'`, `'all'`, `'never'`, a list of names, or a function. A call that `readOnlyWhen` marks as read only never waits.

The agent acts for the Auth user that its Actor stands for (`auth.user(actor)`, or the `user` option), so `context.user` and `context.actor` are set. The capability then runs `console.authorize` for that user, with a request that has no headers, and offers only the operations of the sections it allows. A read-only grant (`'<section>:read'`) offers only the operations that read, and the ones with a `readOnlyWhen` dry run; the run still refuses a write. If the app has no `console.authorize`, nothing filters by section, and the `include` list is the only gate: list only what the agent may do. `content.save` rejects `lease: 'override'` from an agent unless you create the capability with `operations({ overrideLeases: true })`.

The operation registry is installed when the server starts, so the tools do not depend on an earlier RPC call.

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

Every surface reports the same fields. The RPC answers `{ ok: false, code, message, fix, status }`. The CLI prints the code, the message, and the fix on stderr, and exits with `1`. An agent tool returns `{ ok: false, error }` for a status below 500, so the model can act on it.

The core raises these codes:

| Code | When |
| --- | --- |
| `INTERNAL_R0020` | The definition is not valid: a bad name, a reserved input key, a `maxRequestBytes` below 64 KiB. |
| `INTERNAL_R0021` | The call names an operation that the app does not have. |
| `INTERNAL_R0022` | The input does not match the schema. The message lists the fields. |
| `INTERNAL_R0023` | The access does not include the section of the operation, or only reads it (`'<section>:read'`) and the call writes. |
| `INTERNAL_R0024` | The CLI could not reach the app. |
| `INTERNAL_R0025` | A dev server answered for another project. |
| `INTERNAL_B0048` | Two operations have the same name. |
| `INTERNAL_B0049` | Two operations are the same CLI command. |

## Access

The RPC checks the section with `console.authorize` before it runs the operation. A call outside the allowed sections gets `403`. In a build, the RPC route exists when `console` is configured, since it needs `console.auth`.

In `vite dev` without a `console` option, the app serves the RPC (and no Console page) with the local policy, so every section is open. A dev RPC without sign-in (`local` access, or `console: { auth: false }`) answers only loopback requests: the `Host` header must be `localhost`, `127.0.0.1`, or `[::1]`, and the peer address too, when the host exposes it. Any other request gets `403` with `CONSOLE_LOOPBACK_ONLY`. Set `console.auth` to `"app"` or a Console Auth config to open the dev Console to other people.

Duplicate operation names fail every build, also when the app has no `console` option. An app without `server/content.ts` does not contribute the Content operations.

## Built-in operations

`vite-hub` owns the operations of the Console sections: `agents.list`, `agents.invoke`, `invocations.list`, `invocations.get`, `invocations.cancel`, `invocations.delete`, `invocations.workspace`, `invocations.capabilities`, `databases.browse`, `definitions.list`, `env.get`, `schedules.run`, `search.query`, `sections.list`, `status.get`, `usage.get`, `documents.action`, and `media.action`. The [Blob](/docs/development/cli#read-and-write-blobs) package contributes `blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.del`, `blob.media`, and `blob.variants`. The [KV](/docs/development/cli#read-and-write-kv-keys) package contributes `kv.list`, `kv.get`, `kv.has`, `kv.set`, and `kv.del`. The [Email](/docs/development/cli#inspect-the-email-development-outbox) package contributes `email.outbox-list`, `email.outbox-show`, `email.outbox-clear`, and `email.preview`. The [Content](/docs/content/cli) package contributes `content.collections`, `content.list`, `content.show`, `content.status`, `content.diff`, `content.revisions`, `content.save`, `content.publish`, `content.schedule`, `content.unschedule`, `content.schedules`, and `content.sitemap`.
