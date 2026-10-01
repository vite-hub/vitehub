---
title: Database
description: Give an Agent guarded SQL query and schema tools and, in write modes, one mutation tool.
navigation.title: Database
navigation.order: 90
navigation.group: Runtime primitives
icon: i-lucide-database
---

`db()` gives an Agent the `db_query` tool for one read-only SQL statement and the `db_schema` tool for schema inspection. When `mode` or `schemaMode` is `"write"`, it also gives the `db_exec` tool for one mutation statement with a rationale.
All tools call the configured [Database primitive](/docs/server-primitives/database).
The Database primitive page covers application code. This page covers the Agent tools.

## Configure database access

Attach the Database Capability in read mode until the Agent needs guarded mutations.

```ts [server/agents/support.ts]
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

```ts [server/agents/support.ts]
db({ mode: 'write', policy: 'require-approval' })
```

## Agent-visible tool contract

These definitions are resolved from the real Capability during the docs build. They are the names, descriptions, and JSON Schemas supplied to the Agent model.

### Read mode

::agent-capability-tools{name="db" variant="read"}
::

### Data and schema write mode

::agent-capability-tools{name="db" variant="write"}
::

## How database access works

When the Agent Invocation resolves its tools, the Capability resolves the database handle. With `database`, it calls `database(name)` on the handle.

- `db_query` accepts one `SELECT`, one `WITH ... SELECT`, or one read-only introspection `PRAGMA` (`table_info`, `table_xinfo`, `table_list`, `index_list`, `index_info`, `index_xinfo`, `foreign_key_list`, `foreign_key_check`). It calls `query(statement)`.
- `db_schema` takes no input. It returns `{ database, schema }`, where `schema` comes from the `schema` value or `schema()` function on the database handle.
- `db_exec` requires a non-empty `rationale` and exactly one statement. It rejects read-only SQL. DDL (`ALTER`, `CREATE`, `DROP`, `REINDEX`, `VACUUM`) requires `schemaMode: 'write'`. Data mutations (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`) require `mode: 'write'`. It rejects other statements. It calls `exec(statement)`.

The guard rejects multi-statement input before the statement reaches the database handle. `WITH` statements are classified by their final statement keyword.

## Requirements

- Configure the Database primitive. Generated Agent routes pass `agentDb` from `@vite-hub/database/drizzle` to the Capability when the Database Vite integration (`hubDb()`) is active.
- Without a `db` handle, the Capability imports `agentDb` from an installed `@vite-hub/database/drizzle` package. If that import fails, tool resolution fails and the Agent Driver does not receive Database tools.
- The database handle must expose raw string `query()` for `db_query` and `exec()` for `db_exec`.
- A `database` value other than `"default"` requires a handle that exposes `database()`. Otherwise the tools fail with `Database "<name>" is not available.`

## Security and approval

- `db_query` and `db_schema` have no policy gate. The Agent can read every table that the database handle can read.
- `db_exec` is present only when `mode` or `schemaMode` is `"write"`. Each mode allows only its own kind of statement.
- The guard classifies statements by their keywords. It is not a database permission system. Use database credentials with the smallest set of privileges that the Agent needs.
- `policy` applies only to `db_exec`. The single-statement, rationale, and SQL-kind checks run also when `policy` allows the call.
- `policy` accepts `'allow'`, `'require-approval'`, `'deny'`, `'retryable-failure'`, or a function that receives `{ name, input }` and returns one of these values.
- Without `policy`, an enabled `db_exec` call runs when the Agent calls it.
- `'require-approval'` stops the call with `APPROVAL_REQUIRED` and an Approval Request. The request input contains the statement and the rationale. See [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces).

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `db_query`, `db_schema`, and `db_exec` when a write mode is enabled. |
| Provider-backed | Receives the same tools through the provider MCP bridge. |
| Custom-run-backed | `driver.run` receives the tools in `context.tools` and decides whether to call them. |

## Verify database access

1. Start the Vite development server.
2. Run `vitehub agent info --agent support --json`. Confirm that `tools` contains an entry with `name: "db"`, and that `capabilities` contains `{ id: "db", metadata: { schemaMode: "read" } }`.
3. Run `vitehub agent dev "How many users are there?" --agent support`. Confirm that the output shows a `[tool] db_query` call.
4. Ask the Agent to run two statements in one `db_query` call. Confirm that the tool rejects the input before it reaches the database.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `string` | `"default"` | Selects a named database through `database()` on the database handle. |
| `mode` | `"read" \| "write"` | `"read"` | Allows data mutation through `db_exec` when set to `"write"`. |
| `schemaMode` | `"read" \| "write"` | `"read"` | Allows DDL through `db_exec` when set to `"write"`. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | none (calls run) | Policy for `db_exec`. |

## Related pages

- [Database primitive](/docs/server-primitives/database)
- [Official capabilities](/docs/capabilities/official-capabilities)
- [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces)
