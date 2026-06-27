---
title: Instructions
description: Compose model-facing behavior with instruction documents, Source Instructions, and Capability instruction slots.
navigation.order: 24
icon: i-lucide-scroll-text
---

An instruction document is Markdown that ViteHub composes into model-facing instructions. Use it for durable behavior, trust boundaries, source-use policy, and uncertainty handling. Capabilities and Sources contribute their own instruction blocks when they own the guidance.

Model Driver Instructions are the model-backed Agent Driver field that receives the composed document. ViteHub keeps that model-facing surface separate from harness and custom-run execution.

## Add an instruction document

Place `instructions.md` beside a workspace-backed Agent module when the instructions are long enough to read better as Markdown. ViteHub loads that sibling file before model execution.

```md [server/agents/support/instructions.md]
# Support

You are a support engineer.

Answer from inspected workspace evidence before using outside knowledge.

When sources do not answer the question, say that directly.
```

```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
  },
  workspace: {
    sources: {},
  },
})
```

Use strings, string arrays, or instruction callbacks when the instruction text is short or generated from trusted runtime data.

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

## Import Markdown

Use static `@./path.md` imports to split a large instruction document into local Markdown files.

```md [server/agents/support/instructions.md]
# Support

@./shared-style.md

@./escalation-policy.md
```

Imports are relative to the file that declares them. ViteHub expands imported Markdown recursively, up to four levels, and processes imported Markdown like the parent document. Imports inside code spans and fenced code blocks stay literal.

Instruction imports only read relative files. Remote URLs, absolute paths, and globs fail because an instruction document should not widen runtime reachability.

## Read invocation context

Instruction composition can read explicit `context.*` paths from trusted Agent Invocation Context Values. Use double braces for scalar values and triple braces for trusted Markdown content.

```md [server/agents/support/instructions.md]
Answer for {{ context.customerName }}.

{{{ context.supportPolicy }}}
```

The value must already exist in invocation context. Composition does not read arbitrary runtime objects, environment variables, request fields, or JavaScript expressions.

## Branch with conditions

Use `if`, `else-if`, and `else` blocks for conditional instruction sections.

```md [server/agents/support/instructions.md]
::if{context.audience === 'technical'}
Include implementation details and cite file paths.
::else-if{context.audience === 'support'}
Prefer customer-facing language and next actions.
::else
Keep the answer concise.
::
```

Conditions use a small safe expression subset: `context.*` paths, string, number, boolean, and `null` literals, equality checks, `&&`, `||`, `!`, and parentheses. ViteHub rejects function calls, property access outside `context.*`, and other JavaScript.

## Place Capability slots

Capabilities may contribute named instruction blocks. Place one Capability block with `{{ capabilities.<id> }}`, or place every remaining Capability block with `{{ capabilities }}`. ViteHub fails when two Capability contributions use the same instruction block id.

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

Capabilities can also add invocation context values for instruction composition.

```ts [server/agents/support.ts]
import { defineCapability } from '@vite-hub/agent'

const supportAudience = defineCapability({
  id: 'support-audience',
  configure(context) {
    context.context.set('audience', 'technical')
    context.context.set('customerName', 'Acme')
  },
})
```

## Place Source Instructions

Sources can contribute Source Instructions through the low-level `WorkspaceSource.instructions` field. Put `{{ workspace.sources }}` where those instructions belong in the final model instructions.

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

Only visible Sources render Source Instructions. When Access selects a Workspace Scope, ViteHub omits hidden Source Instructions with the hidden files. Markdown never grants access; Access and Workspace Scope remain the runtime enforcement boundary.

## Harness and run drivers

Harness-backed drivers do not receive Model Driver Instructions by default. Use harness-specific configuration or Workspace instruction surfaces instead.

Custom `driver.run` code receives prepared runtime context and decides which values to read. It does not receive a composed model prompt unless your code builds one.

## Next steps

- Read [Agent Drivers](/docs/agents/agent-drivers) for driver-specific instruction behavior.
- Read [Workspace context](/docs/agents/workspace-context) for Source Instructions.
- Read [Capabilities](/docs/capabilities) for Capability-owned instruction blocks.
