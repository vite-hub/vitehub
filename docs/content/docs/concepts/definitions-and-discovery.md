---
title: Definition discovery
description: Understand how a ViteHub file becomes a named runtime entry.
navigation.order: 10
navigation.group: Application model
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

Read [Agent Definitions](/docs/agents/agent-definitions) for Agent-specific files and [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) for the build side.
