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
}
```

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

To call an operation from an agent, add the capability:

```ts [server/agents/editor.ts]
import { operations } from 'vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [operations({ include: ['reports.*'], approve: 'destructive' })],
})
```

Each operation becomes a tool named after it, with dots as underscores: `reports.list` is `reports_list`. `approve` says which operations wait for approval: `'destructive'` (the default), `'write'`, `'all'`, `'never'`, a list of names, or a function. The agent acts for the user that its Actor stands for, so `context.user` and `context.actor` are set.

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
| `INTERNAL_R0014` | The definition is not valid. |
| `INTERNAL_R0015` | The call names an operation that the app does not have. |
| `INTERNAL_R0016` | The input does not match the schema. The message lists the fields. |
| `INTERNAL_R0017` | The access does not include the section of the operation. |
| `INTERNAL_R0018` | The CLI could not reach the app. |
| `INTERNAL_B0048` | Two operations have the same name. |

## Access

The RPC checks the section with `console.authorize` before it runs the operation. A call outside the allowed sections gets `403`. In `vite dev` without a `console` option, the Console uses the local policy, so every section is open. In a build, the RPC route exists when `console` is configured, since it needs `console.auth`.

## Built-in operations

`vite-hub` owns the operations of the Console sections: `agents.list`, `agents.invoke`, `invocations.list`, `invocations.get`, `invocations.cancel`, `invocations.delete`, `invocations.workspace`, `invocations.capabilities`, `blob.list`, `kv.list`, `kv.get`, `databases.browse`, `definitions.list`, `env.get`, `schedules.run`, `search.query`, `sections.list`, `status.get`, `usage.get`, `documents.action`, and `media.action`. The [Content](/docs/content/cli) package contributes `content.collections`, `content.list`, `content.show`, `content.status`, `content.diff`, `content.revisions`, `content.save`, `content.publish`, `content.schedule`, `content.unschedule`, `content.schedules`, and `content.sitemap`.
