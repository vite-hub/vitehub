---
title: Agent definitions
description: Declare the model-backed actor, its instructions, workspace boundary, and attached capabilities.
navigation.order: 21
icon: i-lucide-file-user
---

An Agent Definition is the code declaration that names an Agent and configures how it runs.

It can include:

- Instructions.
- Model configuration.
- Workspace context.
- Capabilities.
- Invocation hooks.
- Custom run behavior.

## Minimal definition

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  instructions: 'Answer support requests with short, concrete replies.',
  model: gateway('openai/gpt-5.1-mini'),
})
```

The discovered Agent name comes from the file location. If this file is `server/agents/support.ts`, the discovered name is `support`.

## Add capabilities

Capabilities expose controlled abilities to the model.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { webSearch, workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  instructions: [
    'Answer from project context first.',
    '{{ capabilities }}',
  ].join('\n\n'),
  model,
  capabilities: [
    workspaceShell({ mode: 'read' }),
    webSearch({ mode: 'tool' }),
  ],
})
```

Tools are contributed by Capabilities. They are not top-level Agent Definition fields.

## Add workspace context

```ts
import { source } from '@vite-hub/workspace'

export default defineAgent({
  workspace: {
    sources: {
      docs: source.glob({
        cwd: '.',
        include: ['README.md', 'docs/**/*.md'],
      }),
    },
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
  instructions,
  model,
})
```

The Workspace supplies files. The Capability decides whether the model can inspect or edit them.

## Keep app runtime config out of callbacks

Agent callbacks receive Agent-owned runtime metadata. Server code should read app-owned environment and runtime values through Server Env or other server primitives.
