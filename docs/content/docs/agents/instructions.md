---
title: Instructions
description: Compose model-facing behavior with Model Driver Instructions, Source Instructions, and Capability instruction slots.
navigation.order: 24
icon: i-lucide-scroll-text
---

Model Driver Instructions are model-facing instructions configured on a model-backed Agent Driver. Put them under `defineAgent({ driver: { model, instructions } })` so ViteHub can keep model execution separate from harness and custom-run execution.

Instructions should describe durable behavior, trust boundaries, and uncertainty handling. Capabilities and Sources contribute their own instruction blocks when they own the guidance.

## Add Model Driver Instructions

Use strings, string arrays, or instruction callbacks for model-backed drivers. Keep the text stable and aligned with the Agent's actual Capabilities.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'You are a support engineer.',
      'Answer from inspected workspace evidence before using outside knowledge.',
      'When sources do not answer the question, say that directly.',
    ],
  },
})
```

Do not document tool syntax in instructions when a Capability can expose that syntax through tool metadata. Instructions should name policy and behavior, not repeat API reference.

## Place Capability slots

Capabilities may contribute named instruction blocks. Place one Capability block with `{{ capabilities.<id> }}`, or place every remaining Capability block with `{{ capabilities }}`.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Answer from source files first.',
      '{{ capabilities }}',
    ],
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

Use slots when the Agent should receive Capability-owned guidance without copying that guidance into every Agent Definition.

## Place Source Instructions

Sources can contribute Source Instructions. Put `{{ workspace.sources }}` where those instructions belong in the final model prompt.

```ts [server/agents/docs.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { file } from '@vite-hub/workspace'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Answer from public docs.',
      '{{ workspace.sources }}',
    ],
  },
  workspace: {
    sources: {
      docs: file({
        path: 'docs.md',
        instructions: 'Use this source for published product behavior.',
      }),
    },
  },
})
```

Only visible Sources render Source Instructions. When Access selects a Workspace Scope, ViteHub omits hidden Source Instructions with the hidden files.

## Harness and run drivers

Harness-backed drivers do not receive Model Driver Instructions by default. Use harness-specific configuration or Workspace instruction surfaces instead.

Custom `driver.run` code receives prepared runtime context and decides which values to read. It does not receive a composed model prompt unless your code builds one.

## Next steps

- Read [Agent Drivers](/docs/agents/agent-drivers) for driver-specific instruction behavior.
- Read [Workspace context](/docs/agents/workspace-context) for Source Instructions.
- Read [Capabilities](/docs/capabilities) for Capability-owned instruction blocks.
