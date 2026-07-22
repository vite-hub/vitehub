---
title: Evals
description: Run repeatable checks against Agent Definitions and score Agent Invocation behavior.
navigation.order: 30
icon: i-lucide-clipboard-check
---

Agent Evals are repeatable development checks that run an Agent Definition against one or more scenarios and score the resulting Agent Invocations. Use them when behavior matters more than one manual local test.

ViteHub Agent Evals use `defineEval` and run through the Agent test runner. They preserve Agent Driver, Capability, Workspace, and runtime boundaries unless a variant explicitly overrides model-backed driver fields.

Keep the harness adapter, credentials, session key, harness sandbox provider, and runtime selection on the Agent Definition's Agent Driver. An eval should declare scenarios and scorers; it should not duplicate the Agent Driver setup. Harness sandbox provider setup is Agent Package runtime plumbing resolved from defaults or `driver.sandbox`. Add `sandbox({ commands })` only when the model should receive `sandbox_exec`.

Eval authoring is an advanced Agent Package surface, so keep its runner dependencies explicit even when the app uses the `vite-hub` framework distribution.

```bash [Terminal]
pnpm add -D @vite-hub/agent evalite vitest
```

## Define an eval

Create eval files beside the Agent they protect. A sibling `support.eval.ts` can import `./support`, and a folder-level `eval.ts` can infer `./agent`.

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

`test(t)` is an Agent Invocation helper.
Call `t.send(...)` with the first user message, then call it again for follow-ups that should keep the same Chat History.
Use `messages` or `context` in the input when the eval needs a precise starting state, and split independent checks into separate scenarios.

### Eval Definition options

`defineEval()` accepts one `scenarios` array or one imperative `test` callback. The two forms are mutually exclusive.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `agent` | Agent Definition or async factory | Sibling Agent | Selects the Agent under test. `support.eval.ts` infers `support.ts`; a folder `eval.ts` infers `agent.ts`. |
| `name` | `string` | Eval file name | Names the Evalite suite. A folder `eval.ts` uses the folder name. |
| `runtimeConfig` | object or async factory | `{}` | Supplies app-owned Agent runtime configuration to each invocation. |
| `scorers` | `AgentScorer[]` | `[]` | Applies scorers to every declarative scenario or to the imperative test. |
| `variants` | `AgentEvalVariant[]` | Baseline only | Runs every case against named model or instruction variants. |
| `workspace` | `WorkspaceName` | Agent Workspace | Selects the Workspace used by the test runner. |
| `scenarios` | `AgentEvalScenario[]` | Mutually exclusive with `test` | Declares one or more independent inputs and optional per-scenario scorers. An empty array is rejected. |
| `test` | callback | Mutually exclusive with `scenarios` | Runs a conversation-shaped imperative check through `AgentEvalTestContext`. |

### Imperative test helpers

| Helper | Purpose |
| --- | --- |
| `send(input)` | Runs a string or full Agent Invocation input and returns the normalized observation. Repeated calls preserve the test conversation. |
| `completed()` | Requires a completed invocation. |
| `textContains(value)` | Requires response text to contain a string or match a regular expression. |
| `calledTool(name)` | Requires one normalized tool call with the given name. |
| `doesNotCallTool(name)` | Requires the named tool to remain unused. |
| `capabilityExtension(id, key?)` | Reads a Capability finish extension from the latest observation. |
| `hasCapabilityExtension(id, key?)` | Requires a Capability finish extension to exist. |
| `expect(scorer)` | Applies a custom `AgentScorer` to the latest observation. |
| `observation` | Exposes the latest observation when one has been sent. |
| `reply` | Exposes the latest response text. |

Use `scenarios` when one eval file should run several cases or reuse the same scorers.

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

Scenarios pass normal Agent Invocation input.
Scorers receive the Agent output text, raw result, tool steps, usage, warnings, capability finish extensions, scenario name, and variant name.

### Scenario options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Identifies the case in Evalite output. |
| `input` | `AgentRunInput` | Yes | Supplies `prompt`, `message`, `messages`, `context`, call `options`, `timeout`, or an `abortSignal`. |
| `metadata` | `unknown` | No | Carries app-owned case metadata into the observation. |
| `scorers` | `AgentScorer[]` | No | Adds case-specific scorers after Definition-level scorers. |

## Compare variants

Variants compare model or instruction changes against the same scenarios. Instruction-only variants require a model-backed Agent Driver. A variant that supplies `model` can also replace a Harness Driver for that eval run.

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

### Variant options

Baseline variants without `model` or `instructions` leave every Agent Driver unchanged. `instructions` can override only a model-backed Driver, while `model` can replace a model-backed or Harness Driver for the variant. Override variants are unsupported for custom `driver.run` Agents and fail before the scenario runs.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Identifies the variant in Evalite output. |
| `model` | `AgentModelInput` | No | Replaces `driver.model` for the variant. |
| `instructions` | `string \| string[]` | No | Replaces `driver.instructions` for the variant. |

## Run evals

The Agent Vite integration writes the Evalite configuration during local setup. Run the Agent eval CLI from the workspace.

```bash [Terminal]
pnpm vitehub agent eval server/agents/support.eval.ts
```

Configure the runner through `hubAgent({ eval })`. Set `eval: false` to disable Agent Evals and their CLI contribution.

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

### Eval Integration options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cache` | `boolean` | `true` | Enables Evalite result caching. |
| `forceRerunTriggers` | `string[]` | Agent and Eval globs | Adds files that force a watch-mode rerun. Defaults to `server/agents/**`, `src/**/*.agent.*`, and `src/**/*.eval.*`. |
| `hideTable` | `boolean` | Evalite default | Hides the terminal score table. |
| `maxConcurrency` | `number` | Vitest default | Limits concurrent eval cases. |
| `scoreThreshold` | `number` | None | Fails the run when its score is below the threshold. |
| `server.port` | `number` | Evalite default | Selects the local Evalite server port. |
| `setupFiles` | `string[]` | `[]` | Loads additional Vitest setup files after Evalite's environment setup. |
| `testTimeout` | `number` | `30_000` | Sets each eval test timeout in milliseconds. |
| `trialCount` | `number` | Evalite default | Repeats each case for the requested number of trials. |

CLI flags override the matching Integration option for one run.

| Flag | Purpose |
| --- | --- |
| `--watch` | Reruns Evals when watched files change. |
| `--threshold <score>` | Overrides `scoreThreshold`. |
| `--output <path>` | Writes the completed Evalite result as JSON. |
| `--hide-table` | Hides the terminal score table. |
| `--no-cache` | Disables Evalite caching for this run. |

## Score useful behavior

Good evals score source-grounded answers, refusal behavior, expected tool use, no source leakage, and regressions in usage or latency when Agent usage exists.
Read normalized token usage from `observation.usage` and the finalized invocation trace from `observation.trace`.
When behavior belongs to a Capability, assert its finish extension instead of duplicating host-specific hooks.

```ts [server/agents/support.eval.ts]
import { defineEval } from '@vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  async test(t) {
    const observation = await t.send('What changed in the order forecast?')
    if (observation.trace?.status !== 'completed') {
      throw new Error('Expected a completed Agent Invocation trace.')
    }
  },
})
```

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
- Use `vitehub agent dev` to reproduce a failed input locally.
- Read [Capabilities](/docs/capabilities) for scoring tool and storage behavior.
