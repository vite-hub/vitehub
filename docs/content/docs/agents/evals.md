---
title: Evals
description: Run repeatable checks against Agent Definitions and score Agent Invocation behavior.
navigation.order: 30
icon: i-lucide-clipboard-check
---

Agent Evals are repeatable development checks that run an Agent Definition against one or more scenarios and score the resulting Agent Invocations. Use them when behavior matters more than one manual local test.

ViteHub Agent Evals use `defineEval` and run through the Agent test runner. They preserve Agent Driver, Capability, Workspace, and runtime boundaries unless a variant explicitly overrides model-backed driver fields.

## Define an eval

Create eval files beside the Agent they protect. A sibling `support.eval.ts` can import `./support`, and a folder-level `eval.ts` can infer `./config`.

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

Scenarios pass normal Agent Invocation input. Scorers receive the Agent output text, raw result, tool steps, usage, warnings, scenario name, and variant name.

## Compare variants

Variants compare model or instruction changes against the same scenarios. They apply only to model-backed Agent Drivers.

```ts [server/agents/support.eval.ts]
import { defineEval, textContains } from '@vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  scenarios,
  scorers: [textContains('evidence')],
  variants: [
    { name: 'baseline' },
    {
      name: 'strict',
      instructions: 'Answer only from inspected evidence.',
    },
  ],
})
```

Use a separate Agent Definition when the change affects Capabilities, Workspace context, custom `driver.run` behavior, or host runtime configuration.

## Run evals

The Agent Vite integration writes the Evalite configuration during local setup. Run the Agent eval CLI from the workspace.

```bash [Terminal]
pnpm vitehub agent eval server/agents/support.eval.ts
```

Use `--watch` while editing prompts or scenarios. Use `--threshold` and `--output` when the eval should feed CI or another review surface.

## Score useful behavior

Good evals score source-grounded answers, refusal behavior, expected tool use, no source leakage, and regressions in usage or latency when telemetry is attached.

Keep evals close to the Agent Definition they protect. A small eval with clear scenarios is more useful than a broad suite that hides which boundary changed.

Use tool scorers when the important behavior is whether a Capability ran, not the exact text it returned.

```ts [server/agents/support.eval.ts]
import { callsTool, defineEval, doesNotCallTool, textContains } from '@vite-hub/agent/eval'
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

`callsTool(name)` and `doesNotCallTool(name)` score the normalized tool steps reported by the Agent test runner. Prefer these scorers over matching tool output text.

## Next steps

- Read [Agent Drivers](/docs/agents/agent-drivers) before using model variants.
- Read [DevTools](/docs/agents/devtools) to inspect failed runs.
- Read [Capabilities](/docs/capabilities) for scoring tool and storage behavior.
