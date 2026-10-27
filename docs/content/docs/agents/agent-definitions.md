---
title: Agent Definitions
description: Declare how one Agent runs, what it can use, and how callers reach it.
navigation.order: 10
navigation.group: Define and run
icon: i-lucide-file-user
navigation.kind: Reference
---

An Agent Definition is the single configuration object for one Agent. It selects an [Agent Driver](/docs/agents/agent-drivers), attaches Capabilities and Workspace context, and defines any Channels, Actor resolution, hooks, or hosted runtime behavior.

ViteHub discovers definitions in `server/agents`. Both `server/agents/support.ts` and `server/agents/support/agent.ts` create an Agent named `support`.

## Define an Agent

This Agent answers a prompt with a model. `runtime: false` keeps its execution inline so a direct caller can wait for the result.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  runtime: false,
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer support questions. Say when you need more information.',
  },
})
```

Configure [model credentials](/docs/agents/agent-drivers#use-a-model-backed-driver) before running it. For a first result without a model or API key, follow [First Agent](/docs/getting-started/first-agent).

A Driver selects one execution path: a model, a custom `run` function, typed `ask` questions, or a coding provider. The built-in `driver: 'codex'` and `driver: 'claude-code'` shorthands use `permissions: 'ask'`; provider actions request approval. Read [Agent Drivers](/docs/agents/agent-drivers) for provider setup and tagged options such as `{ kind: 'codex', model: 'gpt-5.5' }`.

Continue with [Run an Agent](/docs/agents/invocations#run-an-agent) to call this definition, or [Build a chat app](/docs/agents/build-a-chat-app) to connect a model to a browser UI.

## Bound an Invocation budget

Use the top-level `budget` option for per-invocation token and cost limits. ViteHub installs the same inspectable `budget` Capability used by reusable Capability lists:

```ts [server/agents/review.ts]
export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  budget: {
    tokens: { total: 80_000, output: 12_000 },
    usd: '0.10',
    mode: 'observe',
  },
})
```

The default `observe` mode records limits and exceedance in the `budget` finish extension. `mode: 'enforce'` fails the Invocation after its normalized usage is available. See [Budget](/docs/agents/capabilities/budget) for provider support and the difference between an Invocation budget, Driver capacity, and host admission.

## Add abilities and context

Capabilities decide which runtime abilities the selected Driver receives. Workspace context decides which files and Sources those abilities can reach.

```ts [server/agents/support/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'
import { glob } from 'vite-hub/workspace'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer from the docs Workspace. Say when the answer is absent.',
  },
  capabilities: [workspaceShell({ mode: 'read' })],
  workspace: {
    sourceRootDir: process.cwd(),
    sources: {
      docs: glob({ cwd: '.', include: ['docs/content/**/*.md'] }),
    },
  },
})
```

Declaring a Workspace does not automatically grant model-backed or custom Drivers file access. Provider Drivers receive the selected Workspace as their working directory; Capabilities still control additional tools and invocation behavior.

AI SDK Model Drivers make one output-only correction call when a known tool receives arguments that fail its input schema. The correction cannot select another tool or execute a provider-defined tool. Set `driver.execution.repairToolCall: false` to disable this behavior.

## Extend an Agent

Use `extends` to reuse one Agent Definition. The child gets a fresh runtime; Channels and hooks merge by key; matching entries replace inherited values. Static Capabilities merge by ID, with an optional extension hook. Persistent stores remain shared when both definitions select the same store.

Read [Agent presets and inheritance](/docs/agents/agent-presets#extend-an-agent) for examples, merge rules, shared Skills, and Workspace discovery.

### Named presets

Use `preset` and `presets` to select a locally imported definition by name. Select one parent with either `preset` or `extends`.

Choose a [ready-made preset](/docs/agents/presets), or [publish your own](/docs/agents/agent-presets#named-presets) with typed options and a `configure` callback.

## Return structured output

Set `driver.output` when downstream code needs validated data instead of free-form text.

```ts [server/agents/triage.ts]
import * as v from 'valibot'
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Classify the request and explain the next action.',
    output: {
      schema: v.object({
        priority: v.picklist(['low', 'normal', 'urgent']),
        nextAction: v.string(),
      }),
    },
  },
})
```

Inline `runAgent()` execution returns the validated structured result. A schema failure fails the invocation instead of returning unchecked model output. Workflow-backed calls return an `AgentWorkflowRun` after the Workflow starts. Poll `getWorkflowRun(workflowName, run.id)` until its status is `completed`, then read `result` for the validated Agent value. Treat `failed`, `cancelled`, and `unknown` as terminal states instead of waiting indefinitely.

When an AI SDK Model Driver returns invalid native structured output, it makes up to three total attempts by default: the original request and two output-only correction calls. Set `driver.output.maxAttempts` to a positive integer to choose the total attempt limit; `maxAttempts: 1` disables correction calls. Corrections keep the invocation's prepared model and provider route, but they do not replay conversation messages or expose tools, so completed tool effects cannot run again. Tool results remain available as bounded evidence for corrected output. Usage records include every model call, with per-call attribution, aggregate token totals, and aggregate cost when provider metadata or configured pricing supplies it.

Provider Drivers such as `codex` and `claude-code`, and custom-run Drivers, validate their returned output once. They do not accept `maxAttempts` because a second provider session or application callback would replay work instead of performing an output-only Model Driver correction.

## Accept structured data

Set `data` to a Standard Schema when callers pass structured values instead of, or in addition to, model text. ViteHub validates `input.data` before Capabilities, hooks, `intercept`, and the Driver run. Invalid data fails the Invocation: `runAgent()` returns `[Error, null]`, and the Driver does not run.

`data` does not replace `prompt` or `messages`. Model Drivers and provider Drivers do not read `data`, so pass the text they need in `prompt` or `messages`. A `prompt` also names Console sessions and gives the `title()` Capability its source text. Hooks, `intercept`, and custom-run Drivers receive the parsed value.

Call sites use the schema input type. Hooks and `intercept` receive the schema output type. A custom-run Driver reads the same parsed value from `input.data` with the type `unknown`. ViteHub applies a schema transform once, before any of them run.

ViteHub validates changed data again after input hooks and before the Driver runs. It detects in-place changes to arrays, plain records, `Date`, `RegExp`, `Map`, `Set`, `URL`, and `URLSearchParams`. Replace other class instances instead of mutating their internal state, which ViteHub cannot snapshot.

Hooks and Capabilities receive the parsed output, but changed data is validated as schema input. Do not replace transformed output with another value; define the desired value in the original input form instead.

## Finish before the Driver

Set `intercept` when app code can answer some Invocations without the Driver. The handler receives the same context as an `agent:input` hook plus the parsed `data`. Return `undefined` to continue to the Driver. Return another value to finish the Invocation with that value as its output. Throw to fail the Invocation.

Without an Agent `data` schema, `intercept.data` uses `input.data` when it exists. Otherwise, a Channel-triggered Invocation uses the Trigger's message, validated by the Channel's `message.data` schema. The value stays typed as `unknown`, since direct Invocations and explicit trigger data can have another shape. Use an Agent `data` schema when interception needs a known type.

A Capability trigger that selects a Channel can omit its message. Without an Agent `data` schema or explicit `input.data`, `intercept.data` stays `undefined`.

```ts [server/agents/labeller.ts]
import * as v from 'valibot'
import { defineAgent } from 'vite-hub/agent'

const email = v.object({ from: v.string(), subject: v.string() })

const rules = [
  { rule: 'github', from: '@github.com', label: 'GitHub' },
  { rule: 'billing', from: '@stripe.com', label: 'Billing' },
] as const

export default defineAgent({
  data: email,
  // Config rules decide first. The model runs only when no rule matches.
  intercept: ({ data }) => {
    const match = rules.find(rule => data.from.endsWith(rule.from))
    return match ? { source: 'rule' as const, rule: match.rule, label: match.label } : undefined
  },
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Choose one Gmail label for the email.',
    output: { schema: v.object({ source: v.literal('model'), label: v.string() }) },
  },
})
```

```ts [server/lib/sync.ts]
import { runAgent } from 'vite-hub/agent'
import labeller from '../agents/labeller'

const [error, output] = await runAgent(labeller, {
  data: { from: email.from, subject: email.subject },
  prompt: `${email.from}: ${email.subject}`,
})
if (error) throw error
if (output instanceof Response || !('source' in output)) throw new Error('Expected inline labeller output')
// output: { source: 'rule', rule: 'github' | 'billing', label: 'GitHub' | 'Billing' } | { source: 'model', label: string }
```

The `runAgent()` output type is the union of the awaited `intercept` return type, excluding the `undefined` fall-through signal, and the `driver.output` schema output. The caller narrows it with the fields of each result and does not parse the output again. As for any Agent, the type also includes `Response` and `AgentWorkflowRun`, so exclude those first.

An intercepted Invocation skips the Driver, tools, and start Capabilities. `agent:finish` hooks receive the intercepted value as `result`. The `agent.invocation.finish` trace event sets `agent.intercepted: true` and records the value as `result.output`. Traces record `input.data` and `result.output` only when the trace content policy is `content`; the `metadata` policy keeps only `input.hasData`.

The Capability pipeline pauses before its first `prepare` callback or preparation hook, and tool resolution waits for interception. When `intercept` returns `undefined`, the pipeline resumes at that point and keeps the configured Capability and phase order. Phases after that point do not run for an intercepted Invocation, so their input or context changes are not available to `intercept`. Data changed by a resumed phase is validated before the Driver runs.

A child Agent that sets `data` or `intercept` replaces the parent value. ViteHub does not merge schemas or compose interceptors.

## Choose hosted execution

Discovered Agents use the active host's Workflow integration by default. Set `runtime: false` when a hosted Agent must complete inline, or select a named Workflow identity with `runtime: workflow('support')`.

The two-argument `runAgent(agent, input)` form cannot discover the host Workflow by itself. Set `runtime: false` for standalone inline calls, supply an explicit `workflow('support')` binding, or pass a host Runtime Context. See [Run without a host context](/docs/agents/invocations#run-without-a-host-context).

## Definition options

| Option | Purpose |
| --- | --- |
| `extends`, `preset`, `presets` | Reuse one parent Definition. See [Agent presets and inheritance](/docs/agents/agent-presets). |
| `options`, `configure`, `configKey` | Expose typed settings on a reusable Agent preset. |
| `driver` | Required unless inherited. Selects one built-in provider, model-backed, or custom-run execution path. |
| `capabilities` | Attaches a static list or invocation-time Capability resolver. |
| `workspace` | Declares or reuses scoped files, Sources, bindings, and access policy. |
| `sandbox` | Runs a built-in provider Driver inside a [Sandbox](/docs/agents/sandboxes) with a checkout, private Home, environment, and boot checks. Cannot be combined with `workspace`. |
| `driver.instructions` | Configures instructions on the selected Driver; see [Instructions](/docs/agents/instructions). |
| `driver.output` | Validates structured Agent output. |
| `data` | Validates structured Invocation input and types `data` at call sites and in hooks. |
| `intercept` | Finishes an Invocation with app-computed output before the Driver runs. |
| `channels` | Declares named Agent Channels and generated routes. |
| `messages` | Applies shared delivery, streaming, concurrency, session, and transcript settings to adapter Channels. |
| `invoker` | Configures Agent Actor profiles and resolution using the current API name. |
| `runtime` | Selects inline or Workflow-backed hosted execution. |
| `invocations` | Selects the [Invocation journal](/docs/agents/invocation-storage) and its storage policy. |
| `hooks` | Observes input, completion, failure, Capability lifecycle, or hook execution. Finish and error hooks act on the triggering Channel message through [`event.message`](/docs/agents/channels#act-on-the-channel-message-in-hooks). |
| `runEvents` | Publishes application-owned progress for an invocation with a stable run id. |
| `name`, `description`, `version` | Adds explicit discovery and inspection metadata. |
| `cli.capabilities` | Enables or disables Capability-contributed CLI commands. |

Use the dedicated pages for option details rather than growing the Definition itself: [Drivers](/docs/agents/agent-drivers), [Channels](/docs/agents/channels), [Actors](/docs/agents/actors), and [Invocations](/docs/agents/invocations).
