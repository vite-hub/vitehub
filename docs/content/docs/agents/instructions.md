---
title: Instructions
description: Compose durable agent behavior with explicit capability instruction slots.
navigation.order: 22
icon: i-lucide-scroll-text
---

Instructions tell the Agent how to behave across invocations. Keep them direct, stable, and aligned with the abilities the Agent actually has.

## Base instructions

```ts
export default defineAgent({
  instructions: [
    'You are a support engineer.',
    'Answer from the connected workspace before using outside knowledge.',
    'When sources do not answer the question, say that directly.',
  ].join('\n\n'),
  model,
})
```

Do not document tool syntax in instructions when a Capability can expose that syntax through tool metadata. Instructions should describe policy and behavior, not repeat API reference.

## Capability slots

Capabilities may contribute named instruction blocks.

```ts
export default defineAgent({
  instructions: [
    'Answer from source files first.',
    '{{ workspace }}',
    '{{ capabilities }}',
  ].join('\n\n'),
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
  model,
})
```

Use slots when the Agent should receive capability-owned guidance without copying it into every Agent Definition.

## Keep instructions scoped

Good instructions say:

- What the Agent should optimize for.
- Which sources to trust.
- How to handle uncertainty.
- What not to reveal or mutate.
- When to ask for clarification.

Weak instructions list every possible command, host, or package. Put those details in Capability docs, tool descriptions, and server primitive docs.
