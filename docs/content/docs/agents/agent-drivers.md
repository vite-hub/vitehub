---
title: Agent Drivers
description: Choose model-backed, provider-backed, or application-owned Agent execution.
navigation.order: 30
navigation.group: Configure
icon: i-lucide-cpu
---

An Agent Driver decides how one invocation runs. Choose the smallest execution surface that matches the work.

| Choose | Use it when |
| --- | --- |
| Model-backed | ViteHub should run a model and its Capability-contributed tool loop. |
| Provider-backed | Codex or Claude Code should own the coding-agent loop, tools, approvals, and session. |
| Custom run | Application code should own the entire operation. |

Built-in `"codex"` and `"claude-code"` values are provider-backed. Application-supplied Drivers use exactly one of `{ model }` or `{ run }`.

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

## Use a provider-backed Driver

The built-in Drivers reuse T3 Code's normalized Codex and Claude Code runtime while ViteHub owns Agent Definitions, Capabilities, Workspaces, Invocations, and public lifecycle events.

```ts [server/agents/review/agent.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    kind: 'codex',
    instructions: 'Review the exact pull request head before changing code.',
    model: 'gpt-5.5',
    permissions: 'ask',
  },
  workspace: { mode: 'write' },
})
```

Provider Drivers require a local Node.js host with the matching CLI and credentials available to the process. Provider Workspaces additionally require a POSIX host. Each invocation receives a temporary working directory, optional Workspace files, `AGENTS.md` or `CLAUDE.md`, and Capability tools through a private loopback MCP server. Successful write-mode runs commit through Workspace rules; failed and cancelled runs do not write back.

Provider runtime cursors resume a thread while the Agent Definition process remains active. Chat-backed cursors are additionally partitioned by origin, invoker, and resolved Chat Session so a new session cannot inherit provider context from an earlier one. Cursors are process-local and do not survive restarts or resume on another worker; use the Agent Invocation message history as the durable conversation boundary.

Threads resume with the provider's opaque cursor. ViteHub normalizes assistant text, reasoning, native and Capability tool activity, approvals, provider questions, usage, warnings, errors, and terminal state into Agent Invocation events.

| Option | Purpose |
| --- | --- |
| `kind` | Required tagged provider name: `"codex"` or `"claude-code"`. |
| `model` | Optional provider model id. |
| `env` | Explicit environment values passed to the local provider process. ViteHub otherwise inherits only standard host paths, locale, and user-directory variables, not arbitrary application secrets. |
| `execution.attachments.maxBytes` | Optional positive per-invocation image attachment budget; defaults to 25 MiB. Inline and application-resolved lazy images share the budget. |
| `instructions` | Invocation-scoped instructions composed with colocated instructions. |
| `permissions` | `"ask"`, `"allow-edits"`, or `"allow-all"`; defaults to `"allow-all"`. |
| `output` | Optional structured Agent output contract. |
| `capacity` | Optional process-local concurrency and queue limits. |

Provider Drivers do not accept Agent Boxes, model-specific Provider Tool contributions, Cloudflare Agents, or Deno. Provider Workspaces are also unsupported on Windows. These boundaries fail explicitly. Workspace-scoped Skills and ordinary Capability tools are supported.

## Use a custom run Driver

Use `driver.run` when application code owns the result and no model loop is needed.

```ts [server/agents/router.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    run({ input, invoker }) {
      return { text: `Accepted ${invoker.id}: ${String(input.prompt ?? '')}` }
    },
  },
})
```

The callback receives prepared input, messages, tools, Workspace access, invocation context, and the resolved Actor as both `actor` and `invoker`. A custom run callback may call a model internally, but ViteHub treats that execution and usage as application-owned behavior.

Read [Instructions](/docs/agents/instructions) for model-facing behavior and [Workspace context](/docs/agents/workspace-context) for files and writeback.
