---
title: Database capability
description: Give an Agent guarded SQL query and schema tools and, in write modes, one mutation tool.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-database
---

`db()` is a Capability, a set of tools for an Agent. It gives `db_query` to run one read-only SQL statement and `db_schema` to read the schema. When `mode` or `schemaMode` is `"write"`, it adds `db_exec` to run one change with a rationale.
All tools use your [Database](/docs/database) setup. For app code, read the [Database server API](/docs/database/server-api).

## Configure database access

Use read mode until the Agent must change data.

```ts [server/agents/support.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { db } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    db({ mode: 'read' }),
  ],
})
```

To allow data changes but not DDL, set `mode: 'write'` and keep `schemaMode: 'read'`.

```ts [server/agents/support.ts] fragment
db({ mode: 'write', policy: 'require-approval' })
```

## Agent-visible tool contract

The docs build reads these from the real Capability. They are the names, descriptions, and JSON Schemas that the Agent model sees.

### Read mode

::agent-capability-tools{name="db" variant="read"}
::

### Data and schema write mode

::agent-capability-tools{name="db" variant="write"}
::

## How database access works

The Capability finds the database handle when the Agent run loads its tools. With `database`, it calls `database(name)` on the handle.

- `db_query` accepts one `SELECT`, one `WITH ... SELECT`, or one read-only introspection `PRAGMA` (`table_info`, `table_xinfo`, `table_list`, `index_list`, `index_info`, `index_xinfo`, `foreign_key_list`, `foreign_key_check`). It calls `query(statement)`.
- `db_schema` takes no input. It returns `{ database, schema }`, where `schema` comes from the `schema` value or `schema()` function on the database handle.
- `db_exec` requires a non-empty `rationale` and exactly one statement, and calls `exec(statement)`. DDL (`ALTER`, `CREATE`, `DROP`, `REINDEX`, `VACUUM`) requires `schemaMode: 'write'`. Data changes (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`) require `mode: 'write'`. It rejects read-only SQL and all other statements.

The guard rejects input with several statements before it reaches the handle. A `WITH` statement is classified by its final keyword.

## Requirements

- Configure Database. With `hubDb()` active, generated Agent routes pass `agentDb` from `@vite-hub/database/runtime/registry` to the Capability.
- Without a `db` handle, the Capability imports `agentDb` from `@vite-hub/database/runtime/registry`. If that fails, the Agent Driver gets no Database tools.
- The handle must have a raw string `query()` for `db_query` and `exec()` for `db_exec`.
- A `database` other than `"default"` needs a handle with `database()`. Otherwise the tools fail with `Database "<name>" is not available.`

## Security and approval

- `db_query` and `db_schema` have no policy gate. The Agent can read every table the handle can read.
- `db_exec` exists only when `mode` or `schemaMode` is `"write"`. Each mode allows only its own kind of statement.
- The guard sorts statements by keyword. It is not a permission system. Give the Agent database credentials with the fewest privileges it needs.
- `policy` applies only to `db_exec`. The single-statement, rationale, and SQL-kind checks still run when `policy` allows the call.
- `policy` accepts `'allow'`, `'require-approval'`, `'deny'`, `'retryable-failure'`, or a function that gets `{ name, input }` and returns one of them.
- Without `policy`, `db_exec` runs when the Agent calls it.
- `'require-approval'` stops the call with `APPROVAL_REQUIRED` and an Approval Request that holds the statement and rationale. See [Runtime policy, approvals, and traces](/docs/agents/runtime-policy).

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets `db_query`, `db_schema`, and, in a write mode, `db_exec`. |
| Provider-backed | Gets the same tools through the provider MCP bridge. |
| Custom-run-backed | `driver.run` gets the tools in `context.tools` and decides whether to call them. |

## Verify database access

1. Start the dev server.
2. Run `vitehub agent info --agent support --json`. Check that `tools` has an entry with `name: "db"`, and `capabilities` has `{ id: "db", metadata: { schemaMode: "read" } }`.
3. Run `vitehub agent dev "How many users are there?" --agent support`. Check for a `[tool] db_query` call.
4. Ask the Agent to run two statements in one `db_query` call. Check that the tool rejects it before it reaches the database.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `string` | `"default"` | Named database, through `database()` on the handle. |
| `mode` | `"read" \| "write"` | `"read"` | `"write"` allows data changes through `db_exec`. |
| `schemaMode` | `"read" \| "write"` | `"read"` | `"write"` allows DDL through `db_exec`. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | none (calls run) | Policy for `db_exec`. |

## Related pages

- [Database primitive](/docs/database)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
