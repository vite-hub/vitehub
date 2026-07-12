---
title: Agent Drivers
description: Choose model-backed, harness-backed, or custom-run-backed execution for an Agent Definition.
navigation.order: 22
icon: i-lucide-cpu
---

An Agent Driver selects how one Agent Invocation is processed. Every Agent Definition has one driver object with exactly one concrete key: `model`, `harness`, or `run`.

The concrete key holds the implementation value directly. Driver-specific options are sibling fields on the same `driver` object.

## Choose a driver

| Driver | Use it when | Driver-owned options |
| --- | --- | --- |
| `driver.model` | The Agent should call an AI SDK model through ViteHub model execution. | `instructions`, `execution` |
| `driver.harness` | The Agent should run through an AI SDK harness adapter behind ViteHub's Agent Harness Driver Contract. | `credentials`, `instructions`, `sandbox`, `sessionKey`, `workDir` |
| `driver.run` | The Agent should execute developer code directly. | none |

Driver variants are mutually exclusive. A single Agent Definition cannot combine `driver.model` with `driver.run`, or `driver.harness` with model instructions.

## Model-backed driver

Use a model-backed driver for normal model execution. Put Model Driver Instructions and model execution settings inside `driver`.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
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

Capability Driver Contributions such as model-facing tools are filtered for the selected Agent Driver before the model call. Free-form Capability guidance belongs in Agent Driver Instructions or deterministic imported instruction Markdown.

## Harness-backed driver

Use a harness-backed driver when the Agent should delegate execution to a harness adapter. ViteHub adapts the harness behind the Agent Harness Driver Contract and keeps permission policy under ViteHub runtime boundaries.

Install the Agent Package with the harness adapter package you use.

```bash [Terminal]
pnpm add @vite-hub/agent @ai-sdk/harness @ai-sdk/harness-codex @ai-sdk/sandbox-vercel
```

```ts [server/agents/codex/config.ts]
import { createCodex } from '@ai-sdk/harness-codex'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    harness: createCodex({
      model: 'gpt-5.5',
      reasoningEffort: 'low',
    }),
    credentials: { label: 'local Codex', source: 'ambient' },
    instructions: 'Review the exact pull request head before changing code.',
    workDir: 'repositories/vitehub',
  },
})
```

ViteHub resolves harness sandbox setup through the Agent Package runtime. Workspace-backed harness drivers in Vite dev use ViteHub's trusted local harness sandbox by default. Other runtime paths use the AI SDK Vercel Sandbox default when `@ai-sdk/sandbox-vercel` is installed. When an Agent needs a specific harness process or session provider, pass it through `driver.sandbox`:

```ts
import { createCodex } from '@ai-sdk/harness-codex'
import { defineAgent } from '@vite-hub/agent'
import { createLocalHarnessSandbox } from '@vite-hub/agent/harness/local-sandbox'

export default defineAgent({
  driver: {
    harness: createCodex({ model: 'gpt-5.5' }),
    sandbox: () => createLocalHarnessSandbox({ rootDir: '/tmp' }),
  },
})
```

`sandbox({ commands })` remains the Capability shape for model-facing command execution authority.

`driver.harness`, `driver.instructions`, `driver.sessionKey`, `driver.sandbox`, and `driver.workDir` can also be callbacks. Each callback receives the invocation `input`, `context`, `invoker`, and run metadata. Use callbacks when one Agent Definition needs invocation-scoped harness auth, instructions, sandbox setup, working directory, or session reuse.

ViteHub resolves `driver.instructions` before constructing the AI SDK `HarnessAgent`, so stock harness adapters receive the invocation-specific instructions for generated and streamed turns. Session reuse keeps the harness adapter's normal instruction lifecycle. `driver.workDir` must resolve to a non-empty relative POSIX path inside the sandbox default working directory.

Harness-backed drivers receive resolved Capability tools through harness tool support, but they do not receive provider tools or ambient Capability, Source, or Skill prose.
When a Capability should support harness execution with files, declare those files with `requires.workspace.paths` or contribute them through Workspace Sources.

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

Use `driver.run` when developer code owns the Agent behavior. The run callback receives prepared input, messages, tools, Workspace access when configured, Agent Invocation Context Values, and `context.invoker`.

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

- Read [Instructions](/docs/agents/instructions) for model-backed instruction composition.
- Read [Invocations](/docs/agents/invocations) for `runAgent` and `streamAgent`.
- Read [DevTools](/docs/agents/devtools) to inspect resolved driver metadata.
