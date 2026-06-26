---
title: Agent Evals
description: Run repeatable behavior checks against Agent Definitions from the ViteHub CLI.
navigation.order: 34
icon: i-lucide-clipboard-check
---

Agent Evals are repeatable development checks that run an Agent Definition against cases and score the resulting Agent Invocations.
Use them when a model, instruction, Capability, or Workspace change needs behavior proof.

## Define an eval

Keep eval files close to the Agent Definition they protect.
The Agent Eval Runner discovers evals and writes an Evalite config with ViteHub defaults.

```ts [server/agents/support.eval.ts]
import { defineEval } from '@vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  async test(t) {
    await t.send('How do I run provisioning?')
    t.completed()
    t.textContains('vitehub provision')
  },
})
```

`test(t)` runs Agent Invocations.
Call `t.send(...)` with the first user message, then call it again for follow-ups that should keep the same Chat History.
Pass `messages`, `context`, or trigger input to model a specific starting state, and use separate scenarios for independent cases.

Use `scenarios` when one eval file should run several cases or share scorers across cases.

```ts [server/agents/support.eval.ts]
import { defineEval, textContains } from '@vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  scenarios: [
    {
      name: 'answers from docs',
      input: { prompt: 'How do I run provisioning?' },
      scorers: [
        textContains('vitehub provision'),
      ],
    },
  ],
})
```

## Run the evals

Run all discovered Agent Evals with no target.
Pass a path when you want one Agent Eval Target.

```bash [Terminal]
pnpm vitehub agent eval
pnpm vitehub agent eval server/agents/support.eval.ts
```

Use output and threshold options in CI-shaped checks.

```bash [Terminal]
pnpm vitehub agent eval --threshold 0.9 --output .vitehub/evals/support.json --hide-table
```

Long-running model or harness evals should set `agent.eval.testTimeout` in `vite.config.ts` instead of adding ad hoc timeouts inside eval files.

## Configure defaults

Agent Eval defaults belong under the Agent Package integration options.
Use this when the app needs repeatable local and CI behavior.

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAgent({
      eval: {
        maxConcurrency: 2,
        scoreThreshold: 0.85,
        testTimeout: 60_000,
      },
    }),
  ],
})
```

## What to score

| Behavior | Useful assertion |
| --- | --- |
| Source-grounded answer | Expected citation, phrase, or refusal when the Source does not answer. |
| Capability behavior | Tool was used, rejected, omitted, or reported through `hasCapabilityExtension(id)` as expected. |
| Access boundary | Scoped-out Workspace content does not appear in the answer. |
| Cost or latency | Agent Usage Record stays within the expected budget when telemetry is attached. |

Use `callsTool(name)` and `doesNotCallTool(name)` from `@vite-hub/agent/eval` for tool-use expectations. They read the Agent test runner's normalized tool steps, so the eval does not need to match rendered tool output text.

## Next steps

- Use [CLI](/docs/development/cli) for command options.
- Use [DevTools](/docs/development/devtools) for interactive Agent Invocation inspection.
- Use [Runtime events](/docs/reference/runtime-events) for Agent Usage and Trace Event language.
