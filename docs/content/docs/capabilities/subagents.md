---
title: Subagents
description: Delegate bounded work to named Agent Definitions through model-facing tools.
navigation.title: Subagents
navigation.order: 45
navigation.group: Invocation
icon: i-lucide-users-round
---

`subagents()` exposes one tool per configured child Agent Definition.
Use it when the main Agent should delegate bounded work without giving the model a generic agent runner.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Name each subagent with a lowercase stable identifier and give it a concrete description.

## What it adds

The Capability adds model-facing tools such as `run_researcher` or an explicit `toolName`.
Each tool starts the configured child Agent with a message, optional structured context, optional call options, and an inherited invoker.

## Configuration

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { subagents } from '@vite-hub/agent/capabilities'
import researcher from './researcher'

export default defineAgent({
  driver: { model },
  capabilities: [
    subagents({
      agents: {
        researcher: {
          agent: researcher,
          description: 'Research one narrow question and return sourced notes.',
        },
      },
    }),
  ],
})
```

## Runtime behavior

`subagents()` validates the configured names and tool names before the Agent runs.
At invocation time, each subagent tool starts a fresh child Agent Invocation with the parent runtime context, then awaits the existing serializable Agent result. The model cannot select or reuse the child invocation id.

## Requirements

Each subagent entry requires an `agent` and a non-empty `description`.
Subagent keys must be lowercase stable identifiers, and generated tool names use underscores instead of dashes.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives one model-facing tool per subagent. |
| Provider-backed | Receives one tool for each configured subagent through the provider MCP bridge. |
| Custom-run-backed | Can inspect the configured tools and invoke child Agents directly if the custom runner chooses to. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `agents` | `Record<string, SubagentDefinition>` | required | Named child Agent Definitions exposed as tools. |
| `id` | `string` | `"subagents"` | Capability id and instruction context key. |
| `agents.*.agent` | `AgentInput` | required | Child Agent Definition or Agent input accepted by `runAgent()`. |
| `agents.*.description` | `string` | required | Tool description shown to the model. |
| `agents.*.toolName` | `string` | `run_<name>` | Explicit model-facing tool name. |

Cover delegation guidance in Agent Driver Instructions with explicit Capability coverage blocks. Keep each subagent's description with `agents.*.description` because it is the model-facing tool contract.

## Inspect and verify

Run `vitehub agent info --agent <name> --json` and confirm each subagent appears as a tool with the expected name and description.
Run one delegated task and verify the child invocation id and inherited invoker metadata.
Use [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) from trusted code when the caller needs to inspect or cancel the child after start.

## Reference

- [Agent definitions](/docs/agents/agent-definitions)
- [Agent invocations](/docs/agents/invocations)
- Source: `packages/agent/src/capabilities/subagents.ts`
