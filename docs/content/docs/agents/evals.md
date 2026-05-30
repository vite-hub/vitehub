---
title: Evals
description: Run repeatable checks against Agent Definitions and compare behavior changes.
navigation.order: 29
icon: i-lucide-clipboard-check
---

Agent Evals are repeatable development checks that run an Agent Definition against one or more cases and score the resulting Agent Invocations.

Use evals when behavior matters more than one local manual test.

## Define an eval

```ts [server/agents/support.eval.ts]
import { defineEval, textContains } from '@vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  scenarios: [
    {
      name: 'answers billing questions',
      input: {
        prompt: 'How do I configure billing retries?',
      },
      scorers: [
        textContains('billing'),
      ],
    },
  ],
})
```

## Variants

Variants compare model or instruction changes against a baseline.

```ts
export default defineEval({
  agent: support,
  scenarios,
  variants: [
    { name: 'baseline' },
    {
      name: 'strict',
      instructions: 'Answer only from inspected evidence.',
    },
  ],
})
```

Capability, workspace, custom run, and host-runtime changes should use another Agent Definition so the boundary is explicit.

## What to score

Good evals check:

- Source-grounded answers.
- Refusal behavior.
- Tool-use expectations.
- No source leakage.
- Cost or latency regressions when telemetry is attached.

Keep evals close to the Agent Definition they protect.
