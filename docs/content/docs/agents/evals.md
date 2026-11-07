---
title: Evals
description: Send the same inputs to an Agent every time and score what it does.
navigation.order: 52
navigation.group: Inspect and evaluate
icon: i-lucide-clipboard-check
navigation.kind: Guides
---

An Agent Eval sends fixed input to a real Agent Definition and scores the
result. Use Evals to keep key behavior working: grounded answers, expected tool
use, and refusals when evidence is missing.

An Eval keeps the Agent's Driver, Capabilities, and Workspace, so it tests more
than a prompt. Evals run the Agent inline. Test Workflow scheduling,
durability, and the provider lifecycle separately on your host.

## Add one behavior check

Install the Eval runner:

```bash [Terminal]
pnpm add -D evalite vitest
```

Create the Eval next to its Agent:

```ts [server/agents/support.eval.ts]
import { defineEval } from 'vite-hub/agent/eval'
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

Run it:

```bash [Terminal]
pnpm vitehub agent eval server/agents/support.eval.ts
```

The Eval passes, with exit code `0`, when the Invocation completes and the
reply contains `billing`. A failed Invocation or missing text fails it, with a
non-zero exit code.

You can omit `agent`. `support.eval.ts` uses the sibling `support.ts`, and a
folder `eval.ts` uses the sibling `agent.ts`. Keep the import if it makes the
link clearer.

## Test several scenarios

Use `scenarios` when separate inputs share scorers:

```ts [server/agents/support.eval.ts]
import {
  callsTool,
  defineEval,
  doesNotCallTool,
  textContains,
} from 'vite-hub/agent/eval'
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

A scenario takes normal Invocation input: `prompt`, `messages`, `context`,
call options, timeout, and abort signal. Put unrelated behavior in separate
scenarios, so a failure shows what changed. Scorers on the Eval apply to every
scenario.

| Scorer | Passes when |
| --- | --- |
| `textContains(value)` | The response text contains a string or matches a regular expression. |
| `callsTool(name)` / `doesNotCallTool(name)` | The tool steps include or exclude the tool. |
| `hasCapabilityExtension(id, key?)` | The Capability reported a finish extension. |
| `staysUnderTokenBudget(limit)` | Total tokens stay at or below `limit`. |
| `doesNotLeakSource()` | The response does not appear to contain source code. |

A custom scorer is `{ name, score(observation) }`, where `score` returns
`{ score, passed?, reason? }`.

## Test a conversation

Use `test(t)` for a conversation. Each `t.send()` keeps the test's Chat
History. The helpers check the latest observation:

| Helper | Check |
| --- | --- |
| `completed()` | The latest Invocation completed. |
| `textContains(value)` | The response text contains a string or matches a regular expression. |
| `calledTool(name)` / `doesNotCallTool(name)` | The tool steps include or exclude a tool. |
| `hasCapabilityExtension(id, key?)` | A Capability finish extension exists. |
| `capabilityExtension(id, key?)` | Returns the Capability finish extension value. |
| `expect(scorer)` | A scorer passes. |
| `observation` / `reply` | The latest normalized observation or response text. |

## Compare model variants

Variants run the same cases with another model or other instructions:

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

A variant can replace the model or instructions of a model-backed, Codex, or
Claude Code Driver. A provider Driver variant needs a string model id. To
change Capabilities, Workspace context, custom `driver.run`, or host
configuration, use a separate Agent Definition.

## Configure the runner

ViteHub finds `*.eval.ts`, `*.eval.mts`, `*.eval.tsx`, and folder `eval.*`
files. `vitehub agent eval` exists only when there is at least one Eval file.
Set defaults for every run in `vitehub({ agent: { eval } })`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    agent: {
      eval: {
        cache: true,
        maxConcurrency: 2,
        scoreThreshold: 85,
        testTimeout: 60_000,
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      agent: {
        eval: {
          cache: true,
          maxConcurrency: 2,
          scoreThreshold: 85,
          testTimeout: 60_000,
        },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      agent: {
        eval: {
          cache: true,
          maxConcurrency: 2,
          scoreThreshold: 85,
          testTimeout: 60_000,
        },
      },
    }),
  ],
})
```
:::
::

For one run, use `--watch`, `--threshold <score>`, `--output <path>`,
`--hide-table`, or `--no-cache`. A flag overrides the default.

## Score product behavior

Score what matters to your product: grounded answers, expected tool use,
refusal when evidence is missing, Capability finish effects, and changes in
usage or latency. Read usage from `observation.usage` and the final trace from
`observation.trace`.

Keep provider credentials, model, permissions, and runtime in the Agent
Definition. The Eval owns only scenarios and scores. If you copy runtime setup
into the Eval, you test a different system than your app runs.

An inline Workspace uses the Eval file's directory as its Source root, also
when `agent` is an explicit definition or an async factory. If that directory
has a `workspace/` folder, ViteHub uses it. Set `workspace.sourceRootDir` when
an imported Agent needs Sources from elsewhere. A named Workspace keeps its
registered configuration.

## Next steps

Use [Test an Agent](/docs/agents/testing) for input validation and custom Driver logic. Share tested configuration with [Agent presets and inheritance](/docs/agents/agent-presets). Keep run records with [Invocation storage](/docs/agents/invocation-storage).
