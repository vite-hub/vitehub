---
title: Definition discovery
description: Understand how a ViteHub file becomes a named runtime entry.
navigation.group: Core vocabulary
navigation.order: 10
icon: i-lucide-file-code-2
---

A Definition is a file that declares one named piece of ViteHub behavior or state. Discovery is the rule that finds the file and gives it the name application code and the runtime use later.

## The file location supplies the name

ViteHub derives a Definition's name from the location expected by its package. For example:

```txt
server/agents/support.ts      -> support
server/agents/docs/agent.ts   -> docs
src/triager.agent.ts          -> triager
```

Each package documents its own locations and file suffixes. Follow that package rule when you add a Definition; do not add a second application-side name to compensate for a misplaced file.

## The integration finds the file

The package integration scans the configured project during development and build. It then prepares the routes, imports, bindings, or metadata that the package needs to run.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    run: () => 'ok',
  },
})
```

The Definition stays in application code. Generated files explain what the integration prepared, but they are not the application API.

## Check the discovered result

When a Definition is missing or has the wrong name, check its location, the package integration, and the generated metadata. Fix the discovery rule at its source instead of adding a duplicate declaration.

Read [Agent Definitions](/docs/agents/agent-definitions) for Agent-specific files and [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) for the build side.
