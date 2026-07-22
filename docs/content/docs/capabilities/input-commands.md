---
title: Input commands
description: Transform explicit user commands before the main Agent Invocation runs.
navigation.title: Input commands
navigation.order: 40
navigation.group: Invocation
icon: i-lucide-terminal-square
---

`inputCommands()` adds command parsing for explicit user input before the main Agent Invocation runs.
Use it for commands that transform or enrich the user's prompt, not for host UI state or shell execution.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability scans the latest prompt or user message for configured Input Commands.
Each command can replace text, update the Agent Run Input, or add invocation context before model execution.
Commands that should produce model-facing text must return it explicitly; accepting without handler text removes the matched command text.

## Configuration

Define lowercase stable command names. Add a description when CLI inspection and other inspectors should explain the command.
The default trigger is `/`.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { inputCommands } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    inputCommands({
      commands: {
        docs: {
          description: 'Add documentation context to the request.',
          call: ({ args }) => `Use documentation context for: ${args}`,
        },
      },
    }),
  ],
})
```

## Runtime behavior

`inputCommands()` runs during the input phase.
It finds command invocations in the latest user text, calls the matching command handler, and updates the Agent Run Input before other model-facing behavior consumes it.
Commands without a handler are accepted and removed from model input; they do not implicitly pass arguments or command names through as prompts.
Command `agent:input` hooks run after the command updates the input and before the Agent Driver runs.
Command `agent:finish` hooks run for completed and failed Agent Invocations.

The Capability records command names and descriptions in metadata.
It stops command expansion when no configured command remains.

## Requirements

Command names must be lowercase stable identifiers.
The trigger must be a non-empty string without whitespace.

Input Commands are Capability concerns.
Host Commands that change chat, session, UI, or product state belong outside this Capability.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the transformed prompt, messages, or context before model execution. |
| Harness-backed | Receives the transformed Agent Run Input before harness execution. |
| Custom-run-backed | Receives the transformed Agent Run Input; `driver.run` decides how to use context values. |

## Inspect and verify

Run an invocation with the configured command text.
Inspect the final Agent Run Input and confirm the command text was replaced or the expected context value was added before the Agent Driver ran.

Check Agent inspection metadata for the `inputCommands` Capability and its command descriptions.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `commands` | `Record<string, InputCommand>` | required | Command map keyed by lowercase stable command names. |
| `id` | `string` | `"inputCommands"` | Capability id. |
| `trigger` | `string` | `"/"` | Non-whitespace command prefix. |
| `commands.*.description` | `string` | none | Optional command description for metadata and inspection. |
| `commands.*.call` | `(input) => AgentRunInput \| Response \| string \| void` | remove command text | Handler that accepts, rejects, transforms, or enriches invocation input. |
| `commands.*.run` | same as `call` | none | Accepted alias for `call`; when both are present, `call` wins. |
| `commands.*.channels` | `string[]` | all channels | Optional configured Channel ID allowlist. |
| `commands.*.hooks` | `{ 'agent:input'?, 'agent:finish'? }` | none | Command-scoped lifecycle hooks with `ctx.message.reply/update/react` delivery primitives. |

## Reference

- [chatSummary()](/docs/capabilities/chat-summary)
- [Agent invocations](/docs/agents/invocations)
- Source: `packages/agent/src/capabilities/input-commands.ts`
