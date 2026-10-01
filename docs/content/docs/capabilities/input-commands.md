---
title: Input commands
description: Transform explicit user commands such as /docs before the Agent Driver runs.
navigation.title: Input commands
navigation.order: 40
navigation.group: Invocation
icon: i-lucide-terminal-square
---

`inputCommands()` parses explicit user commands, such as `/docs`, in the latest user input before the Agent Driver runs.
It adds no model-facing tool. Each command handler is server code that can replace text, update the Agent Run Input, add Invocation context, or answer the request directly.
It uses no Server Primitive by itself. Handlers receive the host Runtime Capabilities that the application configures, and `vite-hub` adds Console helpers when the Console is enabled.

Use it for commands that transform or enrich the user's prompt, not for host UI state or shell execution.

## Configure input commands

Define lowercase command names. Add a description to include the command's purpose in CLI and inspection output.
The default trigger is `/`.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { inputCommands } from 'vite-hub/agent/capabilities'

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

With this definition, `/docs billing limits` becomes `Use documentation context for: billing limits` before the Agent Driver runs.

## How input commands work

`inputCommands()` runs in the input phase.

1. It reads the string `prompt` when there are no messages. Otherwise it reads the latest user message, or the string `prompt` when no user message exists.
2. It finds configured commands that start at a word boundary, in textual order. `args` is the text after the command name, up to the next configured command or the end. Unknown commands stay unchanged.
3. It calls the matching handler and applies the result.
4. It continues to scan the updated text. It fails with `AGENT_R0103` when expansion does not end.

| Handler result | Effect |
| --- | --- |
| `string` | Replaces the command text and its `args`. An empty string removes them, but keeps the command when it is the only text. |
| `Partial<AgentRunInput>` | Merges into the Agent Run Input. `context` keys merge. A returned `prompt` or `messages` value replaces the other input form. |
| `Response` | Stops the invocation and returns this response. The Agent Driver does not run. |
| `void`, or no `call` | Removes the command text. Command names and `args` are not passed through as prompts. |

Command `agent:input` hooks run after the command updates the input and before the Agent Driver runs.
Command `agent:finish` hooks run for completed and failed Agent Invocations. Both hooks receive `args`, `name`, `text`, and `message.reply()`, `message.update()`, and `message.react()` delivery helpers. Reactions are transient by default and are removed at finish; pass `{ transient: false }` to keep one.

The Capability records command names, descriptions, Channel allowlists, and the trigger in its metadata.

### Handler context

The handler receives `context`, which includes the Capability runtime context, the current Invocation as `context.invocation`, and `context.reply(body)`.
Generated hosts add the stable Invocation `id` when one is available. `context.reply(body)` sends an immediate Channel reply and returns an empty `204` response. Return that response from the handler to stop the invocation before the Agent Driver runs.

The context also includes the resolved host Runtime Capabilities that the application configures, such as `db`, `kv`, `blob`, `email`, or `connections`.

### Console helpers

When you import `inputCommands()` from `vite-hub/agent/capabilities` and enable the Console with `vitehub({ console })`, handlers also receive `context.console.invocations` and `context.console.invocationUrl()` for links to inspected work.
`invocationUrl()` requires an invocation with `agentName` and `id`, and either `vitehub({ publicUrl })` or a request context.

```ts [server/agents/support.ts]
import { desc } from 'drizzle-orm'
import { inputCommands } from 'vite-hub/agent/capabilities'

const history = inputCommands({
  commands: {
    history: {
      async call({ context }) {
        const { db, schema } = context.console.invocations
        const [latest] = await db
          .select({
            agentName: schema.invocations.agentName,
            id: schema.invocations.id,
          })
          .from(schema.invocations)
          .orderBy(desc(schema.invocations.sequence))
          .limit(1)
        if (!latest?.agentName) return 'No previous invocation.'
        return await context.reply(context.console.invocationUrl({
          agentName: latest.agentName,
          id: latest.id,
        }))
      },
    },
  },
})
```

The full `vite-hub` distribution types the Console helpers. The standalone `@vite-hub/agent` package remains host-neutral.

## Requirements

- Command names must be lowercase stable identifiers: a letter first, then letters, digits, `_`, or `-`.
- A command `description`, when set, must be a non-empty string.
- `channels`, when set, must contain non-empty Channel IDs.
- The trigger must be a non-empty string without whitespace.
- Console helpers require the `vite-hub` import path and `vitehub({ console })`.

Input Commands are Capability concerns.
Host Commands that change chat, session, UI, or product state belong outside this Capability.

## Security and approval

`inputCommands()` adds no model-facing tool, so the model cannot call a command. It has no `policy` option.
Any user who can send input to the Agent can run every configured command. Use `channels` to limit a command to selected Channels. A command with `channels` does not run in invocations without a matching Channel ID, and its text stays in the input.

Handlers run as server code with the host Runtime Capabilities in `context`, such as `db` and `context.console.invocations`. They do not pass through Capability approval. Check `context.actor` or `context.invoker` in the handler before you read private data or change state.

Text that a handler returns becomes model input. Treat `args` as untrusted user input.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the transformed prompt, messages, or context before model execution. |
| Provider-backed | Receives the transformed Agent Run Input before provider execution. |
| Custom-run-backed | Receives the transformed Agent Run Input; `driver.run` decides how to use context values. |

A handler that returns a `Response` stops the invocation before any Agent Driver runs.

## Verify input commands

1. Run `vitehub agent info --agent support --json` and confirm that the `inputCommands` Capability metadata lists each command, its description, and the trigger.
2. Run an invocation with the configured command text.
3. Inspect the final Agent Run Input and confirm that the command text was replaced or the expected context value was added before the Agent Driver ran.
4. For a command that calls `context.reply()`, confirm a `204` response and that the Agent Driver did not run.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `commands` | `Record<string, InputCommand>` | required | Command map keyed by lowercase stable command names. |
| `commands.*.call` | `(input) => Partial<AgentRunInput> \| Response \| string \| void` | remove command text | Handler that rejects, transforms, enriches, or answers the request. Receives `args`, `command`, `context`, `input`, `message`, `name`, and `text`. |
| `commands.*.channels` | `string[]` | all Channels | Configured Channel ID allowlist. |
| `commands.*.description` | `string` | none | Command description for metadata and inspection. |
| `commands.*.hooks` | `{ 'agent:input'?, 'agent:finish'? }` | none | Command-scoped lifecycle hooks with `ctx.message.reply/update/react` delivery helpers. |
| `id` | `string` | `"inputCommands"` | Capability id. |
| `trigger` | `string` | `"/"` | Non-whitespace command prefix. |

## Related pages

- [chatSummary()](/docs/capabilities/chat-summary)
- [Agent Invocations](/docs/agents/invocations)
- [Channels](/docs/agents/channels)
- [Official Capabilities](/docs/capabilities/official-capabilities)
