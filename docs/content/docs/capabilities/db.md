---
title: Database
description: Expose guarded database schema, query, and mutation tools to an Agent.
navigation.title: Database
navigation.order: 90
navigation.group: Runtime primitives
icon: i-lucide-database
---

`db()` adds model-facing tools for a configured ViteHub Database primitive.
It exposes read-only query and schema inspection by default, then adds SQL mutation only when write modes allow it.
Cloudflare and Vercel hosted Agent routes receive the Database primitive automatically when the app configures `hubDb()`.

The Capability contributes `db_query` for one read-only SQL statement and `db_schema` for schema inspection.
When data or schema write modes allow it, it also contributes `db_exec` for one mutation statement with a rationale.

## Configure database access

Attach DB in read mode until the Agent needs guarded mutations.
The Database primitive must already be configured by the app.

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

## How database access works

ViteHub selects the configured database handle and enforces the single-statement SQL guardrail.
`db_query` accepts one read-only query.
`db_exec` rejects read-only SQL, requires a rationale, and separates data mutations from schema changes through `mode` and `schemaMode`.

## Requirements

`db()` requires a configured `db` primitive.
The primitive must expose raw string `query()` for reads and `exec()` for mutations.

Mutation tools require write mode.
DDL requires schema write mode.
Enabled mutations are allowed by default, while the single-statement, rationale, and SQL-kind checks still apply.
Set `policy: 'require-approval'` or `policy: 'deny'` when the product needs an additional gate.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `db_query`, `db_schema`, and write tools when enabled. |
| Provider-backed | Receives Database tools through the provider MCP bridge. |
| Custom-run-backed | The configured primitive is available through runtime context; `driver.run` decides how to use it. |

## Verify database access

Run `vitehub agent info --agent <name> --json` and inspect the resolved tool list.
Confirm that read mode shows `db_query` and `db_schema`. A write-capable configuration also lists `db_exec` with the configured policy.

Run a multi-statement SQL input during development.
Confirm that the Capability rejects it before it reaches the Database primitive.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `string` | `"default"` | Selects a named database when the DB primitive supports `database()`. |
| `mode` | `"read" \| "write"` | `"read"` | Allows data mutation through `db_exec` when set to `"write"`. |
| `schemaMode` | `"read" \| "write"` | `"read"` | Allows DDL through `db_exec` when set to `"write"`. |
| `policy` | `AgentToolPolicyDecision \| function` | `"allow"` | Policy for `db_exec`. |

## Related pages

- [Database primitive](/docs/server-primitives/database)
- [Official capabilities](/docs/capabilities/official-capabilities)
