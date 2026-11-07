---
title: Agent Definitions
description: Declare how one Agent runs, what it can use, and how callers reach it.
navigation.order: 10
navigation.group: Define and run
icon: i-lucide-file-user
navigation.kind: Reference
---

An Agent Definition is the object that you pass to `defineAgent()` to configure one Agent. It chooses the [Agent Driver](/docs/agents/agent-drivers) that runs it (for example, a model), its Capabilities (tools), its Workspace context (reachable files), and, when needed, Channels, Actor resolution, hooks, and hosted runtime behavior.

ViteHub finds definitions in `server/agents`. Both `server/agents/support.ts` and `server/agents/support/agent.ts` create an Agent named `support`.

## Define an Agent

This Agent answers a prompt with a model. `runtime: false` runs it inline, so a caller can wait for the result.

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

Set up [model credentials](/docs/agents/agent-drivers#use-a-model-backed-driver) first, or follow [First Agent](/docs/getting-started/first-agent) for a result without a model or API key.

The Driver runs the Agent with a model, your own `run` function, typed `ask` questions, or a coding provider from `codexDriver()` or `claudeCodeDriver()` in `vite-hub/agent`. Provider Drivers default to `permissions: 'ask'`, so provider actions ask for approval. [Agent Drivers](/docs/agents/agent-drivers) explains setup and options such as `codexDriver({ model: 'gpt-5.5' })`.

[Run an Agent](/docs/agents/invocations#run-an-agent) shows how to call it, and [Build a chat app](/docs/agents/build-a-chat-app) connects a model to a browser UI.

## Bound an Invocation budget

The top-level `budget` option limits tokens and cost per Invocation (one run of the Agent). It adds the same `budget` Capability that you can put in a Capability list, inspectable the same way:

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

The default `observe` mode records limits and any overrun in the `budget` finish extension. `mode: 'enforce'` fails an Invocation over a limit once its normalized usage is available. [Budget](/docs/agents/capabilities/budget) explains provider support and how this differs from Driver capacity and host admission.

## Add abilities and context

Capabilities decide which tools the Driver gets. Workspace context decides which files and Sources (file sets mounted in the Workspace, such as this project's Markdown) they reach.

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

A Workspace alone gives model and custom Drivers no file access. Provider Drivers get it as their working directory. Capabilities still control other tools and Invocation behavior.

When a model calls a known tool with arguments that fail its input schema, an AI SDK model Driver makes one output-only correction call. It cannot select another tool or run a provider-defined tool. `driver.execution.repairToolCall: false` turns it off.

## Extend an Agent

`extends` reuses an Agent Definition, and the child gets a fresh runtime. Channels merge by key (the child entry wins), hooks by name (the child hook runs after the parent's), and static Capabilities by ID with an optional extension hook. Persistent stores stay shared when both select the same store. [Agent presets and inheritance](/docs/agents/agent-presets#extend-an-agent) has examples, merge rules, shared Skills, and Workspace discovery.

### Named presets

A preset is a named reusable Agent Definition. `preset` and `presets` select a locally imported definition by name. Select one parent only, with `preset` or `extends`. Use a [ready-made preset](/docs/agents/presets), or [publish your own](/docs/agents/agent-presets#named-presets) with typed options and a `configure` callback.

## Return structured output

Set `driver.output` when your code needs validated data instead of free text.

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

- **Inline:** `runAgent()` returns the validated result. Output that fails the schema fails the Invocation, so you never get unchecked model output.
- **Workflow:** `runAgent()` returns an `AgentWorkflowRun` when the Workflow starts. Poll `getWorkflowRun(workflowName, run.id)` until `completed`, then read `result`. Also stop at the final states `failed`, `cancelled`, and `unknown`; do not wait forever.

An AI SDK model Driver retries invalid native structured output:

- Up to three attempts in total by default: the first request and two output-only correction calls. `driver.output.maxAttempts` (a positive integer) sets the total, and `1` turns corrections off.
- Corrections use the same prepared model and provider route, without replaying messages or giving tools, so a past tool effect cannot run again. Tool results stay available as evidence, within a size limit.
- Usage records include every call, with per-call usage, total tokens, and total cost when provider metadata or configured pricing supplies it.

Provider Drivers (`codex`, `claude-code`) and custom-run Drivers validate output once and do not accept `maxAttempts`, because a retry would replay the work in a new session or call. A model correction only asks for new output.

## Accept structured data

Set `data` to a Standard Schema when callers pass structured values, with or without model text. ViteHub validates `input.data` before Capabilities, hooks, `intercept`, and the Driver. Invalid data fails the Invocation: `runAgent()` returns `[Error, null]` and the Driver does not run.

`data` does not replace `prompt` or `messages`. Model and provider Drivers do not read `data`, so pass their text in `prompt` or `messages`. A `prompt` also names Console sessions and gives the `title()` Capability its source text. Hooks, `intercept`, and custom-run Drivers get the parsed value.

Call sites use the schema input type. Hooks and `intercept` get the output type. A custom-run Driver reads the parsed value from `input.data` as `unknown`. A schema transform runs once, before all of them.

Input hooks can change the data, which ViteHub validates again before the Driver runs. It detects in-place changes to arrays, plain records, `Date`, `RegExp`, `Map`, `Set`, `URL`, and `URLSearchParams`. It cannot snapshot other class instances, so replace them instead of changing them. Changed data is validated as schema input, so write values in the original input form, not as a transformed output.

## Finish before the Driver

Set `intercept` when your code can answer some Invocations without the Driver. It gets the `agent:input` hook context plus the parsed `data`. Return `undefined` to continue to the Driver, another value to finish with that output, or throw to fail.

Without an Agent `data` schema, `intercept.data` is `input.data` when present. Otherwise a Channel-triggered Invocation uses the Trigger message, validated by the Channel's `message.data` schema. The type stays `unknown`, because direct Invocations and explicit trigger data can differ; use an Agent `data` schema for a known type. A Capability trigger that selects a Channel can leave out its message, and then `intercept.data` stays `undefined`.

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

The `runAgent()` output type is the awaited `intercept` return type (without `undefined`, which only means "continue") or the `driver.output` schema output. Callers tell them apart by their fields without parsing again. As for any Agent, exclude `Response` and `AgentWorkflowRun` first.

When `intercept` finishes an Invocation, the Driver, tools, and start Capabilities do not run. `agent:finish` hooks get the value as `result`, and the `agent.invocation.finish` trace event sets `agent.intercepted: true` with `result.output`. Traces record `input.data` and `result.output` only with the `content` policy; `metadata` keeps only `input.hasData`.

The Capability pipeline and tool resolution wait for `intercept` before the first `prepare` callback or preparation hook. On `undefined`, the pipeline continues from there in the configured order. An intercepted Invocation skips those later phases, so `intercept` does not see their input or context changes. Data that a resumed phase changes is validated before the Driver runs.

A child Agent's `data` or `intercept` replaces the parent's; schemas and interceptors do not merge.

## Choose hosted execution

A discovered Agent runs through the active host's Workflow integration by default. `runtime: false` finishes inline, and `runtime: workflow('support')` selects a named Workflow identity.

`runAgent(agent, input)` cannot find the host Workflow by itself. Set `runtime: false`, give an explicit `workflow('support')` binding, or pass a host Runtime Context. See [Run without a host context](/docs/agents/invocations#run-without-a-host-context).

## Definition options

| Option | Purpose |
| --- | --- |
| `extends`, `preset`, `presets` | Reuse one parent Definition. See [Agent presets and inheritance](/docs/agents/agent-presets). |
| `options`, `configure`, `configKey` | Expose typed settings on a reusable Agent preset. |
| `driver` | Required unless inherited. Selects a built-in provider, model-backed, or custom-run path. |
| `capabilities` | A static list or invocation-time Capability resolver. |
| `workspace` | Declares or reuses scoped files, Sources, bindings, and access policy. |
| `sandbox` | Runs a built-in provider Driver in a [Sandbox](/docs/agents/sandboxes) with a checkout, private Home, environment, and boot checks. Not with `workspace`. |
| `driver.instructions` | Driver [instructions](/docs/agents/instructions). |
| `driver.output` | Validates structured Agent output. |
| `data` | Validates structured Invocation input and types `data` at call sites and in hooks. |
| `intercept` | Finishes an Invocation with app-computed output before the Driver runs. |
| `channels` | Declares named Agent Channels and generated routes. |
| `messages` | Applies shared delivery, streaming, concurrency, session, and transcript settings to adapter Channels. |
| `invoker` | Configures Agent Actor profiles and resolution using the current API name. |
| `runtime` | Selects inline or Workflow-backed hosted execution. |
| `invocations` | Selects the [Invocation journal](/docs/agents/invocation-storage) and its storage policy. |
| `hooks` | Observes input, completion, failure, Capability lifecycle, or hook execution. Finish and error hooks act on the Channel message through [`event.message`](/docs/agents/channels#act-on-the-channel-message-in-hooks). |
| `runEvents` | Publishes application-owned progress for an invocation with a stable run id. |
| `name`, `description`, `version` | Explicit discovery and inspection metadata. |
| `cli.capabilities` | Turns Capability-contributed CLI commands on or off. |

Details: [Drivers](/docs/agents/agent-drivers), [Channels](/docs/agents/channels), [Actors](/docs/agents/actors), and [Invocations](/docs/agents/invocations).
