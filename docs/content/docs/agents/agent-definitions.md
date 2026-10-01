---
title: Agent Definitions
description: Declare how one Agent runs, what it can use, and how callers reach it.
navigation.order: 21
navigation.group: Core
icon: i-lucide-file-user
---

An Agent Definition is the single configuration object for one Agent. It selects an [Agent Driver](/docs/agents/agent-drivers), attaches Capabilities and Workspace context, and defines any Channels, Actor resolution, hooks, or hosted runtime behavior.

ViteHub discovers definitions in `server/agents`. Both `server/agents/support.ts` and `server/agents/support/agent.ts` create an Agent named `support`.

## Define an Agent

Start with the execution path. This Agent uses ViteHub's built-in Codex Driver:

```ts [server/agents/review.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  description: 'Reviews the current repository change.',
  driver: 'codex',
})
```

The shorthand uses `permissions: 'ask'`. Provider actions request approval unless the Agent Definition opts into another policy.

Use a tagged built-in value when the Driver needs options:

```ts [server/agents/review.ts]
export default defineAgent({
  driver: {
    kind: 'codex',
    model: 'gpt-5.5',
    permissions: 'ask',
  },
})
```

For application-supplied execution, use exactly one structural Driver variant: `{ model }`, `{ run }`, or [`{ ask }`](/docs/agents/agent-drivers#use-an-ask-driver).

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

Use `extends` to make one Agent Definition the default for another:

```ts [server/agents/bot-dev/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import bot from '../bot/agent'

export default defineAgent({
  extends: bot,
  driver: { model: 'gpt-5.6-sol' },
  workspace: {
    store: { provider: 'local', root: '.vitehub/workspaces/bot-dev' },
  },
})
```

The child gets a fresh runtime from the parent's configuration. `name` is not inherited; discovery names each Agent from its own file. Configure separate persistent storage when the Agents must keep separate data. An explicitly shared store or adapter remains shared.

Child configuration overrides parent defaults. Channels, Sources, Skills, and hooks merge by key, replacing each matching definition or callback as a whole. Static Capabilities merge by `id`: the child replaces a matching Capability and appends new ones. A Capability resolver replaces the inherited list or resolver. Other arrays replace the parent array. A child `driver.launch` replaces the entire inherited launch command or resolver, including `onExit`. If the child omits `launch`, it inherits the parent launch. Changing a Driver kind or store provider replaces that configuration.

`extends` accepts one definition created by `defineAgent()` in the same package instance. It does not discover files in the parent's directory. Import shared instructions in TypeScript with `?raw` and pass them through `driver.instructions`. Share Skills through explicit Sources or a directory link.

A definition that is not discovered, such as one created in a Schedule, uses the colocated Skills of the discovered Agent it extends. It reads them when it runs, so module import order does not matter. Use `agentWithSkills()` to add Skills to such a definition without an Agent folder:

```ts [server/schedules/changelog.ts]
import { agentWithSkills, defineAgent } from 'vite-hub/agent'
import botDev from '../agents/bot-dev/agent'
import changelogSkill from './changelog-skill.md?raw'

const changelogAgent = agentWithSkills(
  defineAgent({ extends: botDev, name: 'changelog' }),
  { 'changelog-writing': changelogSkill },
)
```

Each key is a Skill name, and each value is its `SKILL.md` content. The result keeps the inherited Skills. A Skill with the same name replaces the inherited one.

### Named presets

Export ordinary `defineAgent()` definitions from a preset package. Consumers import them and select a local name:

```ts
import { defineAgent } from "@vite-hub/agent"
import { notetaker } from "@example/agents"

export default defineAgent({
  preset: "notetaker",
  presets: { notetaker },
  name: "meeting-notes",
  driver: { model: "gpt-5.6-sol" },
})
```

`preset` must name an own entry in `presets`. Selection uses the same composition as `extends`, including child overrides and a fresh runtime. Specify one parent with either `preset` or `extends`. The map belongs to this definition; it does not register global names or load packages. Neither the map nor its selected name becomes model instructions.

Preset packages must declare `@vite-hub/agent` as a peer dependency so their definitions share the application's package instance. Package authors must include instruction content and required assets explicitly; selecting a preset does not discover its package directory.

A preset can expose typed options with the same `defineAgent()` function:

```ts
export const notetaker = defineAgent({
  options: { format: "concise" as "concise" | "detailed", labels: ["notes"] },
  configure: ({ format }) => defineAgent({
    driver: { kind: "codex", instructions: `Write ${format} notes.` },
  }),
})
```

Consumers select the definition and override only the options they need:

```ts
const notes = defineAgent({
  preset: "notetaker",
  presets: { notetaker },
  options: { format: "detailed", labels: [] },
  driver: { model: "gpt-5.4" },
})

notes.options.format // "concise" | "detailed"
```

`options` must be a plain record and uses nested defaults. Built-in instance roots are rejected by the types. Custom class roots are rejected at runtime because TypeScript cannot distinguish their structure from plain records with callbacks. Child values replace parent values, including `false`, empty arrays, and callbacks. Arrays never concatenate. Nested values with required methods, including class instances, require complete replacements. Omitted or `undefined` values retain their defaults. Annotate optional fields and literal unions in the defaults to describe the accepted configuration. TypeScript checks options against the selected preset. If options come from untyped input, validate them in `configure`.

`configure` runs synchronously when defining or extending the Agent. Return a normal Agent Definition and keep this callback free of network calls and other side effects. The callback receives its own option copy. Copies of standard built-ins preserve their own property descriptors and nested values. Custom class instances and values such as `WeakMap`, `WeakSet`, and `Error` retain their identity across option copies. Detached buffers and their views retain identity. Resizable or growable buffers and their views also retain identity, preserving resize behavior and fixed-length or length-tracking views. Ordinary Agent overrides apply after the callback and remain in effect through further extensions. An inherited Agent name is cleared on each extension. For discovered Agents, a Workspace reference object must use a statically known string `name`; `name: undefined` owns a Workspace. Opaque names require an explicit Workspace ownership marker on the configured definition. A configured Agent exposes its resolved `options` for host setup and inspection; these values do not become model instructions automatically.

For folder Agents discovered from `agent.ts`, define `configure` in that file and return a discoverable `defineAgent()` call. Workspace discovery does not execute imported callbacks or opaque helper calls returned by `configure`, including computed calls such as `builders["workspace"]()` and asserted calls such as `build!()` or `(build as Factory)()`. Return `defineAgent()` directly, or declare `workspace: {}` for owned storage or a named Workspace reference on the configured Agent. It rejects an imported `configure` callback because it cannot determine the required Workspace setup. Discovery also rejects unresolved computed settings keys, quoted keys with unsupported escapes, compound `void` expressions, dynamic Workspace values such as `options.workspaceName`, opaque settings spreads such as `...importedSettings`, imported Capability options and preset registries (including object spreads), option-derived Capability lists such as `options.caps`, returned Agent members such as `agents.storage`, imported Agent parents, imported Channel maps, Channels imported from packages, local Channel factories and opaque calls such as `makeChannel()`, first-party Channel helper calls with opaque options such as `github(options.github)` or `github({ pullRequest: options.pullRequest })`, Channel options defined by accessors such as `get pullRequest()`, dynamic preset selections, logical Capability expressions such as `false || [storage]`, constructed Capability lists such as `Array.of(storage)` or `[plain].concat(storage)`, imported Capability values, destructured Capability bindings, and local Capability member access or calls such as `values.storage` and `values.storage()`. If these contribute an owned Workspace, add `workspace: {}` to the Agent definition. Otherwise, define the settings, parents, Channels, and Capabilities locally with direct bindings so discovery can inspect them.

Discovery reads first-party Channel helper calls, such as `github({ pullRequest: false })`, without running them. It also follows a Channel imported from a relative module, such as `import portal from '../portal.github.ts'`, and inspects that module's export with the same rules. It follows re-exports from relative modules, such as `export { default } from './inner.ts'` and `export * from './channels.ts'`, and rejects re-exports from packages. `github()` owns a Workspace only when `pullRequest` is enabled and `pullRequest.workspace` is not `false`. `discord()`, `http()`, `slack()`, `teams()`, `telegram()`, and `webChat()` own a Workspace only through their `capabilities`. An Agent whose Channels own no Workspace stays a stateless Agent; do not add `workspace: {}` to it.

Discovery rejects Channel option bindings that are mutated or passed to opaque calls, including local callbacks and built-in mutators such as `Object.assign`. It does not execute those calls to inspect their effects. Use unmodified local options, or add `workspace: {}` when the Channel owns a Workspace.

Configured presets use the existing layer rules for capabilities, channels, and hooks. A child replaces a capability with the same ID or a channel or hook with the same key. Distinct hooks remain present; same-key hooks do not automatically compose. Option callbacks are values and are also replaced, never invoked by merging.

Publish the exported definition on npm and import it into `presets`. There is no second preset factory or global package loader.


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

With the implicit discovery-default Workflow binding, direct `runAgent()` calls without a discovered host identity remain inline. An explicit `runtime: workflow('support')` binding starts that named Workflow even for a direct call.

## Definition options

| Option | Purpose |
| --- | --- |
| `extends` | Inherits configuration from one Agent Definition. |
| `driver` | Required unless inherited. Selects one built-in provider, model-backed, or custom-run execution path. |
| `capabilities` | Attaches a static list or invocation-time Capability resolver. |
| `workspace` | Declares or reuses scoped files, Sources, bindings, and access policy. |
| `driver.instructions` | Configures instructions on the selected Driver; see [Instructions](/docs/agents/instructions). |
| `driver.output` | Validates structured Agent output. |
| `data` | Validates structured Invocation input and types `data` at call sites and in hooks. |
| `intercept` | Finishes an Invocation with app-computed output before the Driver runs. |
| `channels` | Declares named Agent Channels and generated routes. |
| `github` | Sets the Agent GitHub identity, for example `createGitHubHost()`. Provider Drivers receive its `access().env`, and pull request checkouts and `git()` use its token. Defaults to the identity passed as `github({ app })`. |
| `messages` | Applies shared delivery, streaming, concurrency, session, and transcript settings to adapter Channels. |
| `invoker` | Configures Agent Actor profiles and resolution using the current API name. |
| `runtime` | Selects inline or Workflow-backed hosted execution. |
| `hooks` | Observes input, completion, failure, Capability lifecycle, or hook execution. Finish and error hooks act on the triggering Channel message through [`event.message`](/docs/agents/channels#act-on-the-channel-message-in-hooks). |
| `runEvents` | Publishes application-owned progress for an invocation with a stable run id. |
| `name`, `description`, `version` | Adds explicit discovery and inspection metadata. |
| `cli.capabilities` | Enables or disables Capability-contributed CLI commands. |

Use the dedicated pages for option details rather than growing the Definition itself: [Drivers](/docs/agents/agent-drivers), [Channels](/docs/agents/channels), [Actors](/docs/agents/actors), and [Invocations](/docs/agents/invocations).
