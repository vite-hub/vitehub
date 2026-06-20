---
title: inputCommands()
description: Transform explicit user commands before the main Agent Invocation runs.
navigation.title: inputCommands()
navigation.order: 40
icon: i-lucide-terminal-square
---

`inputCommands()` adds command parsing for explicit user input before the main Agent Invocation runs.
Use it for commands that transform or enrich the user's prompt, not for host UI state or shell execution.

## What it adds

The Capability scans the latest prompt or user message for configured Input Commands.
Each command can replace text, update the Agent Run Input, or add invocation context before model execution.

## Minimum attach example

Define lowercase stable command names and a description for each command.
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
          run: ({ args }) => `Use documentation context for: ${args}`,
        },
      },
    }),
  ],
})
```

## Runtime behavior

`inputCommands()` runs during the input phase.
It finds command invocations in the latest user text, calls the matching command handler, and updates the Agent Run Input before other model-facing behavior consumes it.

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

Check DevTools metadata for the `inputCommands` Capability and its command descriptions.

## Reference

- [chatSummary()](/docs/capabilities/chat-summary)
- [Agent invocations](/docs/agents/invocations)
- Source: `packages/agent/src/capabilities/input-commands.ts`
