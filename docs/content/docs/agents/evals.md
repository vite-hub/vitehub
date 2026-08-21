---
title: Evals
description: Run repeatable scenarios against an Agent Definition and score its behavior.
navigation.order: 60
navigation.group: Verify
icon: i-lucide-clipboard-check
---

Agent Evals run the real Agent Definition against repeatable inputs. They preserve its Driver, Capabilities, and Workspace while running inline, so a passing eval covers more than a standalone model prompt test. Verify Workflow scheduling, durability, and provider lifecycle separately on the configured host.

## Add one behavior check

Install the explicit runner dependencies:

```bash [Terminal]
pnpm add -D @vite-hub/agent evalite vitest
```

Create the eval beside the Agent it protects:

```ts [server/agents/support.eval.ts]
import { defineEval } from '@vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  async test(t) {
    await t.send('How do I configure billing retries?')
    t.completed()
    t.textContains('billing')
  },
})
```

Run it from the workspace:

```bash [Terminal]
pnpm vitehub agent eval server/agents/support.eval.ts
```

A completed invocation containing `billing` passes and exits successfully. A failed invocation or missing text assertion fails the eval and exits non-zero.

Sibling `support.eval.ts` files can infer `support.ts`; a folder-level `eval.ts` can infer `agent.ts`. Keep the explicit `agent` import when it makes the relationship easier to see.

## Test several scenarios

Use declarative scenarios when independent inputs share scorers.

```ts [server/agents/support.eval.ts]
import {
  callsTool,
  defineEval,
  doesNotCallTool,
  textContains,
} from '@vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  scenarios: [
    {
      name: 'inspects workspace before answering',
      input: { prompt: 'Where is the billing retry policy documented?' },
      scorers: [
        callsTool('shell'),
        doesNotCallTool('refund'),
        textContains('billing'),
      ],
    },
  ],
})
```

Scenarios accept normal Agent Invocation input, including `prompt`, `messages`, `context`, call options, timeout, and abort signal. Split unrelated behavior into separate scenarios so a failure identifies the boundary that changed.

Use imperative `test(t)` for a conversation. Repeated `t.send()` calls preserve that test's Chat History, and helpers inspect the latest observation:

| Helper | Check |
| --- | --- |
| `completed()` | The latest invocation completed. |
| `textContains(value)` | Response text contains a string or matches a regular expression. |
| `calledTool(name)` / `doesNotCallTool(name)` | Normalized tool steps include or exclude a tool. |
| `hasCapabilityExtension(id, key?)` | A Capability finish extension exists. |
| `expect(scorer)` | A custom scorer passes. |
| `observation` / `reply` | Access the latest normalized observation or response text. |

## Compare model variants

Variants run the same cases with model or instruction changes:

```ts [server/agents/support.eval.ts]
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

Instruction-only variants require a model-backed Driver. A `model` variant may replace a model-backed or provider-backed Driver for the eval run. Use a separate Agent Definition when the change affects Capabilities, Workspace context, custom `driver.run` behavior, or host configuration.

## Configure the runner

Executable `*.eval.ts`, `*.eval.mts`, `*.eval.tsx`, and folder `eval.*` files enable the generated Evalite configuration. Configure defaults through `hubAgent({ eval })`:

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAgent({
      eval: {
        cache: true,
        maxConcurrency: 2,
        scoreThreshold: 85,
        testTimeout: 60_000,
      },
    }),
  ],
})
```

Useful one-run flags are `--watch`, `--threshold <score>`, `--output <path>`, `--hide-table`, and `--no-cache`. CLI flags override integration defaults.

## Score product behavior

Prefer assertions about the behavior that matters: grounded answers, expected tool use, refusal when evidence is missing, Capability finish effects, and regressions in usage or latency. Read normalized usage from `observation.usage` and the finalized trace from `observation.trace`.

Keep provider credentials, model selection, permissions, and runtime selection on the Agent Definition. An eval owns scenarios and scores; duplicating runtime setup produces a different system than the application runs.
