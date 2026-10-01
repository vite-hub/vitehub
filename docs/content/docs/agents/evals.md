---
title: Evals
description: Run repeatable scenarios against an Agent Definition and score its behavior.
navigation.order: 60
navigation.group: Verify
icon: i-lucide-clipboard-check
---

An Agent Eval sends repeatable input to a real Agent Definition and scores
the result. Use Evals to protect behavior that must keep working: grounded
answers, expected tool use, and refusals when evidence is missing.

An Eval keeps the Driver, Capabilities, and Workspace of the Agent, so it tests
more than a model prompt alone. Evals run the Agent inline. Verify Workflow
scheduling, durability, and the provider lifecycle separately on the
configured host.

## Add one behavior check

Install the Eval runner dependencies:

```bash [Terminal]
pnpm add -D evalite vitest
```

Create the Eval beside the Agent that it protects:

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

The Eval passes when the Invocation completes and the reply contains
`billing`. The command then exits with code `0`. A failed Invocation or a
missing text fails the Eval, and the command exits with a non-zero code.

You can omit `agent`. A `support.eval.ts` file uses the sibling `support.ts`.
A folder `eval.ts` file uses the sibling `agent.ts`. Keep the explicit import
when it makes the relation easier to see.

## Test several scenarios

Use `scenarios` when independent inputs share scorers:

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

A scenario accepts normal Agent Invocation input, including `prompt`,
`messages`, `context`, call options, timeout, and abort signal. Put unrelated
behavior in separate scenarios, so a failure shows which boundary changed.
Scorers set on the Eval itself apply to every scenario.

| Scorer | Passes when |
| --- | --- |
| `textContains(value)` | The response text contains a string or matches a regular expression. |
| `callsTool(name)` / `doesNotCallTool(name)` | The tool steps include or exclude the tool. |
| `hasCapabilityExtension(id, key?)` | The Capability reported a finish extension. |
| `staysUnderTokenBudget(limit)` | Total tokens stay at or below `limit`. |
| `doesNotLeakSource()` | The response does not appear to contain source code. |

A custom scorer is an object with `name` and a `score(observation)` function
that returns `{ score, passed?, reason? }`.

## Test a conversation

Use `test(t)` for a conversation. Each `t.send()` call keeps the Chat History
of that test. The helpers check the latest observation:

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

Variants run the same cases with a different model or instructions:

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

A variant can replace the model or the instructions of a model-backed Driver,
or of a Codex or Claude Code Driver. A provider Driver variant needs a string
model id. Use a separate Agent Definition when the change affects
Capabilities, Workspace context, custom `driver.run` behavior, or host
configuration.

## Configure the runner

ViteHub finds Eval files named `*.eval.ts`, `*.eval.mts`, `*.eval.tsx`, and
folder `eval.*` files. The `vitehub agent eval` command is available only when
at least one Eval file exists. Set defaults for every run under
`vitehub({ agent: { eval } })`:

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

Use these flags for one run: `--watch`, `--threshold <score>`,
`--output <path>`, `--hide-table`, and `--no-cache`. A CLI flag overrides the
configured default.

## Score product behavior

Score the behavior that matters to the product: grounded answers, expected tool
use, refusal when evidence is missing, Capability finish effects, and changes
in usage or latency. Read normalized usage from `observation.usage` and the
final trace from `observation.trace`.

Keep provider credentials, model selection, permissions, and runtime selection
in the Agent Definition. An Eval owns scenarios and scores. If you copy runtime
setup into the Eval, you test a different system from the one the application
runs.

An inline Workspace uses the Eval file directory as its Source root, also when
`agent` is an explicit Agent Definition or an async factory. When that
directory contains a `workspace/` directory, ViteHub uses that directory. Set
`workspace.sourceRootDir` when an imported Agent needs Sources from another
directory. A named Workspace keeps its registered configuration.
