---
title: Definition discovery
navigation.title: Definition discovery
description: Understand how a file location becomes a named ViteHub runtime entry, and check which Definitions the integration found.
navigation.order: 33.1
navigation.group: Build state
icon: i-lucide-file-code-2
---

A Definition is a file that declares named behavior or state, such as an Agent, Queue, or Workspace. Discovery finds the file and assigns the name that application code uses.

## The file location supplies the name

ViteHub derives a Definition's name from its file path. Each package defines which paths it scans. For example:

```txt
server/agents/support.ts      -> support
server/agents/docs/agent.ts   -> docs
src/triager.agent.ts          -> triager
```

Each package documents its paths and file suffixes. Put the Definition in one of those paths instead of adding another name in application code.

## A Definition file turns its feature on

A Definition file in the server directory turns its feature on. You do not add a key to the ViteHub options.

| File | Feature |
| --- | --- |
| `server/agents/` | Agent |
| `server/auth.ts` | Auth |
| `server/browsers/` | Browser |
| `server/channels/` | Channels, and Agent for a Channel that receives webhooks |
| `server/connections/` | Connections |
| `server/queues/` | Queue |
| `server/realtime/` | Realtime |
| `server/schedules/` | Schedule |
| `server/workflows/` | Workflow |
| `server/workspaces/` | Workspace |

A folder counts when it has at least one source file. In Nuxt, the server directories of the layers count too.

- Set the key to `false` to keep the feature off, for example `queue: false`. ViteHub then loads no code and adds no routes for it.
- Set the key to an object only to change options, for example `queue: { driver: 'memory' }`.
- Features without Definition files, such as `kv`, `blob`, `database`, `email`, and `mcp`, still need their key.
- A Definition with a file suffix, such as `src/welcome-email.queue.ts`, does not turn its feature on. Set the key for it.
- When you add an owner plugin, such as `hubQueue()`, next to `vitehub()`, set `queue: false` in `vitehub()`, so the feature loads one time.

When the package of the feature is not installed, the build fails with [`VITE_HUB_DEFINITION_PACKAGE_MISSING`](/docs/development/diagnostics/vite_hub_definition_package_missing). The message shows the `pnpm add` command.

## The integration finds the file

The package integration scans the project during development and build. It prepares the routes, imports, bindings, or metadata that the package needs.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    run: () => 'ok',
  },
})
```

The Definition stays in application code. Generated files show what the integration prepared, but application code doesn't import them unless the package documents that import.

## Check the discovered result

If a Definition is missing or has the wrong name, check its location, the package integration, and the generated metadata.

Read [Agent Definitions](/docs/agents/agent-definitions) for Agent-specific files and [Vite Integrations and Provider Output](/docs/development/integrations-and-output) for the build side.
