---
title: Agent Drivers
description: Choose model-backed, harness-backed, or application-owned Agent execution.
navigation.order: 30
navigation.group: Configure
icon: i-lucide-cpu
---

An Agent Driver decides how one invocation runs. Choose the smallest execution surface that matches the work.

| Choose | Use it when |
| --- | --- |
| Model-backed | ViteHub should run a model and its Capability-contributed tool loop. |
| Harness-backed | The Agent should inspect files, run commands, use Skills, or preserve a harness session. |
| Custom run | Application code should own the entire operation. |

Built-in `"codex"` and `"claude-code"` values are harness-backed. Custom Drivers use exactly one of `{ model }`, `{ harness }`, or `{ run }`.

## Use a model-backed Driver

Model-backed execution fits support answers, classification, extraction, structured output, and bounded tool use.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer support requests from inspected evidence.',
    execution: {
      callSettings: { temperature: 0.2 },
      stepLimit: 8,
    },
  },
})
```

Model strings run through AI Gateway. ViteHub discovers `AI_GATEWAY_API_KEY` from the process or Cloudflare Server Env. Supply an explicit descriptor when the Definition owns the credential:

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

const apiKey = process.env.SUPPORT_AI_GATEWAY_API_KEY
if (!apiKey) throw new Error('SUPPORT_AI_GATEWAY_API_KEY is required')

export default defineAgent({
  driver: {
    model: { id: 'zai/glm-5v-turbo', apiKey },
  },
})
```

The `model` value may also be a compatible AI SDK model or an invocation-time callback. Keep authorization in Access or Capability policy; use model callbacks and instrumentation for routing and call settings.

### Model options

| Option | Purpose |
| --- | --- |
| `model` | Required model id, `{ id, apiKey }`, AI SDK model, or callback. |
| `instructions` | String, string array, or callback parts. Defaults to colocated instructions when available. |
| `maxRetries` | Common model retry count. Do not also set `execution.callSettings.maxRetries`. |
| `execution.callSettings` | Provider and AI SDK call settings. |
| `execution.stepLimit` | Maximum model tool-loop steps; defaults to `20`. |
| `execution.instrumentation` | Invocation-scoped model wrapping or call-setting overrides. |
| `execution.workspaceFallback` | Controls synthesis from Workspace evidence when a run produced tool results but no text. |

## Use a harness-backed Driver

A harness wraps a model with its agent loop, tool protocol, sessions, context management, and permission behavior. ViteHub composes that harness with Skills, Workspace context, Capabilities, and an optional Box.

![A model wrapped by a harness, with Skills and explicit Workspace, Box, and Sandbox layers.](/images/tutorials/harness-layers-flat.png)

Use the vendor's matched harness when ViteHub provides an adapter. The built-in Codex and Claude Code Drivers keep their model-specific behavior while ViteHub owns the surrounding runtime contract.

```ts [server/agents/review/agent.ts]
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

The default local harness sandbox is a temporary process workspace, not OS isolation. It does not inherit application secrets by default. Use a [Box](/docs/agents/boxes) when the harness needs a declared Home, checkout, credentials, requirements, or provider-specific execution environment.

Do not combine `box` with `driver.sandbox` or `driver.workDir`; the Box owns those concerns. For Claude Code with a Box, set `{ kind: 'claude-code', sandbox: false }` so the Box owns the process environment.

### Harness options

| Option | Purpose |
| --- | --- |
| `harness` | Required only for a custom harness adapter or callback. |
| `credentials` | Records non-secret credential provenance for inspection. |
| `instructions` | Supplies invocation-scoped harness instructions. |
| `requires` | Declares Box requirements; built-in Drivers contribute their own. |
| `sandbox` | Selects the harness process or session provider when no Box is configured. |
| `sessionKey` | Reuses harness session identity when supported. |
| `workDir` | Selects a relative POSIX path inside the harness sandbox. |

Harness Drivers receive Capability tools when the harness supports them. They do not receive ambient Capability, Source, or Skill prose. Put durable repository guidance in colocated `instructions.md`, and declare required Workspace paths explicitly.

## Use a custom run Driver

Use `driver.run` when application code owns the result and no model loop is needed.

```ts [server/agents/router.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    run({ input, invoker }) {
      return {
        text: `Accepted ${invoker.id}: ${String(input.prompt ?? '')}`,
      }
    },
  },
})
```

The callback receives prepared input, messages, tools, Workspace access, invocation context, and the resolved Actor as both `actor` and `invoker`. A custom run callback may call a model internally, but ViteHub then treats model execution and usage as application-owned behavior.

## Keep the layers separate

| Layer | Responsibility |
| --- | --- |
| Model | Generates output and tool-call decisions. |
| Harness | Runs the model-specific agent loop and session lifecycle. |
| Skills | Provide reusable procedures and supporting files. |
| Workspace | Provides scoped files, Sources, rules, and writeback. |
| Box | Prepares Home, checkout, credentials, and process requirements. |
| Sandbox | Provides the selected process or session environment; isolation requires an isolation-capable provider. |

Read [Instructions](/docs/agents/instructions) for model-facing behavior, [Workspace context](/docs/agents/workspace-context) for files, and [Boxes](/docs/agents/boxes) for prepared harness environments.
