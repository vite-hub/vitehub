---
title: Input commands
description: Let users type commands such as /docs that change their message before the Agent runs.
navigation.title: Input commands
navigation.order: 140
navigation.group: Capabilities
icon: i-lucide-terminal-square
---

`inputCommands()` lets users type commands such as `/docs`. Server code handles them before the Agent Driver runs. A handler can replace message text, update the Agent Run Input (the prompt or messages), add an Invocation context value (data one Agent run carries), or answer directly.

It adds no model tool and uses no Server Primitive itself. Handlers get the host Runtime Capabilities you configure, such as `db` or `kv`, plus Console helpers when the Console is on.

Use it for commands that change the prompt, not for host UI state or shell commands.

## Configure input commands

Give each command a lowercase name and an optional description for CLI and inspection. The default trigger character is `/`.

```ts [server/agents/support.ts] fragment
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

Here, `/docs billing limits` becomes `Use documentation context for: billing limits` before the Driver runs.

## How input commands work

In the input phase, `inputCommands()`:

1. Reads the latest user message, or the string `prompt` when there is none.
2. Finds configured commands at word boundaries, in text order. `args` is the text after the name, up to the next command or the end. Unknown commands stay.
3. Calls the handler and applies the result.
4. Scans the text again. Endless expansion fails with `AGENT_R0103`.

| Handler result | Effect |
| --- | --- |
| `string` | Replaces the command and `args`. An empty string also removes the following whitespace, or the preceding at the end. A command that is the only text is kept. |
| `Partial<AgentRunInput>` | Merges into the Agent Run Input. `context` keys merge. A returned `prompt` or `messages` replaces the other form. |
| `Response` | Stops the run and returns it. The Driver does not run. |
| `void`, or no `call` | Removes the command text. Names and `args` are not passed as prompts. |

Commands can have hooks:

- `agent:input` runs after the input update, before the Driver.
- `agent:finish` runs for completed and failed runs.
- Both get `args`, `name`, `text`, and `message.reply()`, `message.update()`, and `message.react()`. Reactions are removed at finish unless you pass `{ transient: false }`.

Metadata records command names, descriptions, Channel allowlists, and the trigger.

### Handler context

The handler's `context` has:

- the Capability runtime context
- `context.invocation`, with the stable `id` when generated hosts have one
- `context.reply(body)`, which sends a Channel reply at once and returns an empty `204`. Return it to stop before the Driver runs.
- your host Runtime Capabilities, such as `db`, `kv`, `blob`, `email`, or `connections`

### Console helpers

When you enable the Console with `vitehub({ console })`, handlers also receive `context.console.invocationUrl()` for links to inspected work. Without the Console, `context.console` is `undefined`.
`invocationUrl()` requires an invocation with `agentName` and `id`, and either `vitehub({ publicUrl })` or a request context.
Read the journal itself with `getAgentInvocations()` from `vite-hub/agent` and `getAgentInvocationsDatabase()` from `vite-hub/agent/invocations/drizzle`. They work with the Console on or off. `getAgentInvocationsDatabase()` opens the [default journal](/docs/agents/invocation-storage#use-the-default-journal) database for Drizzle queries on first use. It resolves to `undefined` for another journal store and on a Worker that keeps the journal in memory.

```ts [server/agents/support.ts]
import { desc } from 'drizzle-orm'
import { inputCommands } from 'vite-hub/agent/capabilities'
import { getAgentInvocationsDatabase } from 'vite-hub/agent/invocations/drizzle'

const history = inputCommands({
  commands: {
    history: {
      async call({ context }) {
        const database = await getAgentInvocationsDatabase()
        if (!database) return await context.reply('Invocation history is not available on this Worker journal.')
        const { db, schema } = database
        const [latest] = await db
          .select()
          .from(schema.invocations)
          .orderBy(desc(schema.invocations.sequence))
          .limit(1)
        if (!latest?.agentName) return 'No previous invocation.'
        if (!context.console) return await context.reply('The ViteHub Console is not enabled.')
        return await context.reply(context.console.invocationUrl({
          agentName: latest.agentName,
          id: latest.id,
        }))
      },
    },
  },
})
```

### Link the previous invocation with `/debug`

Set `debug: true` so a user can send `/debug` after a wrong answer. No other commands are needed.

```ts [server/agents/support.ts]
import { inputCommands } from 'vite-hub/agent/capabilities'

const commands = inputCommands({ debug: true })
```

It replies with the Console URL of the latest earlier run of the same Agent, in the same Channel thread when there is one, and the Driver does not run.

- With no earlier run: `No previous invocation was found in the ViteHub Console.`
- Without `vitehub({ console })`: `The ViteHub Console is not enabled for this Agent.`
- The link follows `invocationUrl()` rules. A `debug` entry in `commands` replaces it.

## Requirements

- Command names must be lowercase stable identifiers: a letter first, then letters, digits, `_`, or `-`.
- A command `description`, when set, must be a non-empty string.
- `channels`, when set, must contain non-empty Channel IDs.
- The trigger must be a non-empty string without whitespace.
- Console helpers require `vitehub({ console })`.
- `debug`, when set, must be `true` or `false`. `commands` is required unless `debug` is `true`.

Input Commands only change Agent input. Host Commands that change chat, session, UI, or product state do not belong here.

## Security and approval

The model cannot call commands. There is no `policy` option.

Anyone who can send input can run every command. `channels` limits a command to selected Channels. Elsewhere, it does not run and its text stays.

> [!WARNING]
> Handlers are server code with Runtime Capabilities such as `db` and `context.console`, and skip Capability approval. Check `context.invoker` before reading private data or changing state.

Returned text becomes model input. Treat `args` as untrusted.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets the transformed prompt, messages, or context. |
| Provider-backed | Gets the transformed Agent Run Input. |
| Custom-run-backed | Gets the transformed input. `driver.run` uses context values as it decides. |

## Verify input commands

1. `vitehub agent info --agent support --json` lists each command, description, and the trigger.
2. Run with the command and check that the final Agent Run Input has the replaced text or context value.
3. A `context.reply()` command returns `204`, and the Driver does not run.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `commands` | `Record<string, InputCommand>` | required unless `debug` is `true` | Command map keyed by lowercase stable command names. |
| `commands.*.call` | `(input) => Partial<AgentRunInput> \| Response \| string \| void` | remove command text | Handler that rejects, transforms, enriches, or answers the request. Receives `args`, `command`, `context`, `input`, `message`, `name`, and `text`. |
| `commands.*.channels` | `string[]` | all Channels | Configured Channel ID allowlist. |
| `commands.*.description` | `string` | none | Command description for metadata and inspection. |
| `commands.*.hooks` | `{ 'agent:input'?, 'agent:finish'? }` | none | Command-scoped lifecycle hooks with `ctx.message.reply/update/react` delivery helpers. |
| `debug` | `boolean` | `false` | Add `/debug`, which replies with the Console link of the previous Invocation. |
| `id` | `string` | `"inputCommands"` | Capability id. |
| `trigger` | `string` | `"/"` | Non-whitespace command prefix. |

## Related pages

- [Agent Invocations](/docs/agents/invocations)
- [Channels](/docs/agents/channels)
- [Official Capabilities](/docs/agents/capabilities/official)
