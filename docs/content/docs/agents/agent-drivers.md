---
title: Agent Drivers
description: Choose model-backed, harness-backed, or custom-run-backed execution for an Agent Definition.
navigation.order: 22
icon: i-lucide-cpu
---

An Agent Driver selects how one Agent Invocation is processed. Use `"codex"` or `"claude-code"` when ViteHub owns the integration, and use a tagged value such as `{ kind: 'codex', model: 'gpt-5.5' }` when a built-in needs options.

Use a structural `{ model }`, `{ harness }`, or `{ run }` object when the application supplies the implementation. Those custom variants are mutually exclusive, and their options are sibling fields on the same object.

## Choose a driver

| Driver | Use it when | Driver-owned options |
| --- | --- | --- |
| `"codex"` or `{ kind: "codex" }` | The Agent should use ViteHub's built-in Codex integration. | `auth`, `credentials`, `env`, `instructions`, `model`, `reasoningEffort`, `sandbox`, `webSearch`, `workDir` |
| `"claude-code"` or `{ kind: "claude-code" }` | The Agent should use ViteHub's built-in Claude Code integration. | `auth`, `credentials`, `env`, `maxTurns`, `model`, `sandbox`, `thinking` |
| `{ model }` | The Agent should call an application-supplied AI SDK model through ViteHub model execution. | `instructions`, `maxRetries`, `execution` |
| `{ harness }` | The Agent should run through an application-supplied AI SDK harness adapter. | `credentials`, `instructions`, `requires`, `sandbox`, `sessionKey`, `workDir` |
| `{ run }` | The Agent should execute application code directly. | none |

Custom driver variants are mutually exclusive. A single Agent Definition cannot combine `driver.model` with `driver.run`, or `driver.harness` with model instructions.

## Model-backed driver

Use a model-backed driver for normal model execution. Put Model Driver Instructions and model execution settings inside `driver`.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    maxRetries: 0,
    instructions: [
      'Answer support requests from inspected evidence.',
      'Use configured Capabilities only for the roles named in these instructions.',
    ],
    execution: {
      callSettings: { temperature: 0.2 },
      stepLimit: 8,
    },
  },
})
```

Model strings are the normal declaration. ViteHub materializes them through AI Gateway and discovers `AI_GATEWAY_API_KEY` from the process or Cloudflare Server Env.

Use a descriptor when the Agent Definition supplies the Gateway credential explicitly:

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

const apiKey = process.env.SUPPORT_AI_GATEWAY_API_KEY
if (!apiKey) throw new Error('SUPPORT_AI_GATEWAY_API_KEY is required')

export default defineAgent({
  driver: {
    model: {
      id: 'zai/glm-5v-turbo',
      apiKey,
    },
  },
})
```

The whole model can resolve for each Agent Invocation, so runtime configuration can select tenant-specific credentials:

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent<{ gatewayKey: string }>({
  driver: {
    model: ({ runtimeConfig }) => ({
      id: 'zai/glm-5v-turbo',
      apiKey: runtimeConfig.gatewayKey,
    }),
  },
})
```

Pass a concrete compatible AI SDK model when an application needs a provider SDK directly. Inspection reports a declarative model's id and Gateway transport without exposing its key.

Capability Driver Contributions such as model-facing tools are filtered for the selected Agent Driver before the model call. Free-form Capability guidance belongs in Agent Driver Instructions or deterministic imported instruction Markdown.

### Model driver options

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `model` | model id, `{ id, apiKey }`, compatible AI SDK model, or callback | Required | Resolves and materializes the model for the invocation. |
| `instructions` | `string`, `string[]`, or callback parts | Colocated instructions when available | Supplies Model Driver Instructions. Callback parts receive trusted runtime and Workspace metadata. |
| `maxRetries` | non-negative integer | AI SDK default | Sets the common model retry count. Do not combine it with `execution.callSettings.maxRetries`. |
| `execution.callSettings` | `Record<string, unknown>` | `{}` | Passes provider and AI SDK call settings to model execution. |
| `execution.stepLimit` | `number` | `20` | Stops the model tool loop after this many steps unless `callSettings.stopWhen` overrides it. |
| `execution.instrumentation.model` | callback | None | Replaces or wraps the resolved model for one invocation. |
| `execution.instrumentation.callSettings` | callback | None | Reads the resolved model, tools, input, Actor, and current settings, then returns call-setting overrides. |
| `execution.workspaceFallback` | `boolean` or object | Enabled | Synthesizes a final answer from Workspace tool results when a run produced evidence but no text. |
| `execution.workspaceFallback.enabled` | `boolean` | `true` | Enables or disables Workspace fallback synthesis. |
| `execution.workspaceFallback.maxToolResults` | `number` | `8` | Limits the tool results supplied to fallback synthesis. Each captured result is truncated to 4,000 characters. |

Instrumentation callbacks run after the Agent and its Capabilities resolve their model-execution contributions. Use them for invocation-scoped routing or call settings, and keep authorization in Access or Capability policy.

## Harness-backed driver

Use a harness-backed driver when the Agent should delegate execution to a harness adapter. ViteHub adapts the harness behind the Agent Harness Driver Contract and keeps permission policy under ViteHub runtime boundaries.

Install the Agent Package. The built-in Codex adapter is included; add an adapter package only when supplying a custom harness or selecting the optional Claude Code driver.

```bash [Terminal]
pnpm add @vite-hub/agent
```

```ts [server/agents/codex/agent.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    kind: 'codex',
    credentials: { label: 'local Codex', source: 'ambient' },
    instructions: 'Review the exact pull request head before changing code.',
    model: 'gpt-5.5',
    reasoningEffort: 'low',
    workDir: 'repositories/vitehub',
  },
})
```

ViteHub resolves harness sandbox setup through the Agent Package runtime. Harness drivers use ViteHub's local harness sandbox by default on process-capable hosts. This is a tempdir-backed shell convenience, not OS/process isolation, and the default does not inherit application secrets from the host environment. Cloudflare Agents and Deno require a process-capable provider. When an Agent needs an isolated or provider-specific harness process, environment, or session provider, pass it through `driver.sandbox`:

```ts
import { defineAgent } from '@vite-hub/agent'
import { createLocalHarnessSandbox } from '@vite-hub/agent/harness/local-sandbox'

export default defineAgent({
  driver: {
    kind: 'codex',
    model: 'gpt-5.5',
    sandbox: () => createLocalHarnessSandbox({ rootDir: '/tmp' }),
  },
})
```

`sandbox({ commands })` remains the Capability shape for model-facing command execution authority.

Use a [Box](/docs/agents/boxes) instead of `driver.sandbox` and `driver.workDir` when the harness should receive an explicit execution environment, Home, working checkout, and boot requirements. The `"codex"` driver contributes its Codex requirement automatically.

`driver.harness`, `driver.instructions`, `driver.sessionKey`, `driver.sandbox`, and `driver.workDir` can also be callbacks. Each callback receives the invocation `input`, `context`, `invoker`, and run metadata. Use callbacks when one Agent Definition needs invocation-scoped harness auth, instructions, sandbox setup, working directory, or session reuse.

## Migrate built-in selectors

Built-in Agent Drivers and Box runtimes are values on their existing definition fields. Remove provider-specific ViteHub imports, use a literal for defaults, and add a `kind` tag only when options are needed:

```ts
// Before
driver: codexDriver({ model: 'gpt-5.5' })
box: { runtime: trustedHost() }

// After
driver: { kind: 'codex', model: 'gpt-5.5' }
box: { runtime: 'trusted-host' }
```

The removed Agent harness and Box provider subpaths no longer export selection factories. Custom drivers still use `{ model }`, `{ harness }`, or `{ run }`; custom Box runtimes still implement the `BoxRuntime` interface and cannot claim a built-in runtime name.

The `"claude-code"` default owns a local harness sandbox, so combine Claude Code with a Box using `{ kind: 'claude-code', sandbox: false }`. The Box then owns the process environment and working directory.

ViteHub resolves `driver.instructions` before constructing the AI SDK `HarnessAgent`, so stock harness adapters receive the invocation-specific instructions for generated and streamed turns. Session reuse keeps the harness adapter's normal instruction lifecycle. `driver.workDir` must resolve to a non-empty relative POSIX path inside the sandbox default working directory.

Harness-backed drivers receive resolved Capability tools through harness tool support, but they do not receive provider tools or ambient Capability, Source, or Skill prose.
When a Capability should support harness execution with files, declare those files with `requires.workspace.paths` or contribute them through Workspace Sources.

### Harness driver options

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `harness` | harness adapter or callback | Required | Resolves the AI SDK harness adapter for the invocation. |
| `credentials` | `{ label?, source? }` | None | Records non-secret credential provenance such as `ambient`, `explicit`, `none`, or `unknown`. |
| `instructions` | `string` or callback | None | Supplies invocation-scoped instructions to the AI SDK `HarnessAgent`. |
| `requires` | `readonly BoxRequirement[]` | `[]` | Declares environment requirements such as `codex`, `codex-cli`, `github`, or an app-owned requirement. Built-in drivers contribute their requirements automatically. |
| `sandbox` | provider object or callback | Local harness sandbox on process-capable hosts | Selects the harness process, environment, or session provider. Do not combine it with `box`. |
| `sessionKey` | `string` or callback | None | Reuses the harness adapter's session identity when the adapter supports sessions. |
| `workDir` | relative POSIX path or callback | Sandbox default working directory | Selects a working directory inside the harness sandbox. Do not combine it with `box`. |

For a fresh TypeScript app, use ESM and NodeNext resolution so the ESM-only ViteHub and harness subpath imports load correctly.

```json [package.json]
{
  "type": "module"
}
```

```json [tsconfig.json]
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022"
  },
  "include": ["server/**/*.ts"]
}
```

`tsc --noEmit` only checks the Agent Definition imports and driver shape. It does not start a real harness invocation.

## Custom run driver

Use `driver.run` when developer code owns the Agent behavior. The run callback receives prepared input, messages, tools, Workspace access when configured, Agent Invocation Context Values, and the resolved Agent Actor as both `actor` and `invoker`.

```ts [server/agents/router.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    async run({ input, invoker }) {
      return {
        text: `Accepted ${invoker.id}: ${String(input.prompt ?? '')}`,
      }
    },
  },
})
```

A custom-run-backed driver can call a model or harness internally, but ViteHub treats the public driver as `run`. Use a model-backed driver when ViteHub should own model execution, tool calls, usage normalization, and model instrumentation.

## Production notes

Hosted harness drivers should use deployable credential sources, not only ambient local CLI auth. ViteHub records the resolved Harness Credential Source when the adapter can report it, without exposing secret material.

Workspace-backed harness execution depends on Harness Workspace Session support in the active package version. When that surface is unavailable, ViteHub should fail early instead of silently passing model-facing Workspace Tools to a harness.

## Next steps

- Read [Harness](/docs/agents/harness) for the model, harness, Skill, and environment layers.
- Read [Instructions](/docs/agents/instructions) for model-backed instruction composition.
- Read [Boxes](/docs/agents/boxes) for trusted-host harness execution.
- Read [Invocations](/docs/agents/invocations) for `runAgent` and `streamAgent`.
- Read [CLI inspection](/docs/development/cli) to inspect resolved driver metadata.
