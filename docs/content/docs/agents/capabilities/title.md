---
title: Title
description: Give each Agent run a short title that shows in the output, in finish hooks, and in chat threads.
navigation.title: Title
navigation.order: 300
navigation.group: Capabilities
icon: i-lucide-heading
---

`title()` gives each Invocation (one Agent run) a short title for a chat list or a record name. It adds no model tool and uses no Server Primitive. It streams the title as output data, gives `{ title }` as a finish extension (read by finish hooks after the run), and can send it to a Channel thread on a chat platform.

The title comes from `execute()`, a title Driver, the inherited provider Driver, an AI SDK model call, or a local heuristic. No chat interface is needed: the finish extension can name a job, run, artifact, or other record.

## Configure titles

Add `title()` to the `defineAgent()` call. With no generator, ViteHub uses the first words of the text.

```ts [server/agents/support.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { title } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    title(),
  ],
})
```

## How titles are generated

`title()` reads the prepared user message matching `run.messageId`, or the last prepared user message when no message ID is available. It uses a string `input.prompt` only when no user message is present. If prepared messages exist and an explicit message ID has no matching user message, it leaves the title unset.
Input Capabilities run first, so `transcribe()` can replace audio with transcript text before `title()` reads it. Audio with authored text uses both in their prepared order.
When the message has no semantic text, such as an attachment-only audio or image message, `title()` waits for the successful Agent reply and uses that text. When the reply is also empty or the invocation fails, it leaves the title unset.

- Input Capabilities run first, so `transcribe()` can replace audio with text before.
- Audio and typed text are both used, in prepared order.
- With no meaningful text, such as only audio or an image, it waits for a successful reply and uses that.
- If the reply is empty too, or the run fails, the title stays unset.

Generator order:

1. `execute`, when set.
2. `driver`, when set.
3. The inherited provider Driver, for a provider-backed Agent when `model` is unset or a string.
4. An AI SDK model: `model`, else the Agent model.
5. A heuristic from the first six words.

The default prompt follows T3 Code's editorial rules: name the subject and outcome in 3 to 8 words, under 40 characters, as JSON with a `title` field. ViteHub keeps the first line, strips quotes, and cuts to `maxLength`. Empty output uses `fallback`.

On failure:

- An explicit `driver` uses `fallback`.
- The inherited provider Driver uses the heuristic.
- `execute` and the AI SDK model use the heuristic on timeout; other errors leave it unset.

A title failure never stops the main answer.

### Stream output

`title()` wraps compatible async and UI message streams, once per result, so the title arrives with the response.

- UI message streams get `{ type: 'data-title', id: 'title', data: { type: 'title', title } }`. A temporary heuristic title can come first; the generated one replaces it with the same part id.
- Async streams and `fullStream` get `{ type: 'data', data: { type: 'title', title } }`.

Finish hooks read it with `event.extensions.get('title')` or your custom `id`.

### Channel delivery

For framework-managed Chat SDK message Channels, ViteHub delivers the title once per thread by default, even when each webhook contains only the current message or the handler is recreated. When an Invocation journal observes the run, follow-up invocations still generate and record their own titles without renaming the platform thread or replacing its established stream title. Without a journal, they skip title generation after successful delivery.

- `channelDelivery: "always"` updates the title on every run.
- If a Channel run fails after generation started, the title gets an `ERROR:` prefix.

Plain `runAgent()` calls and UI runs still get the stream data and finish extension each run.

### Invocation journals

With an Invocation journal (a stored run record), generation starts with the main answer, and cleanup waits for the title up to its timeout or the abort signal.
Metadata journals keep the text only when `metadataContent` includes `vitehub.session.title`, which the Console turns on.

## Provider-backed title runs

On a provider-backed Agent (an external provider such as Codex), `title()` starts a second, smaller run through the inherited provider Driver:

- It gets the main Driver's model, credentials, environment, launch configuration, and permissions, with title instructions. It does not reuse the main credential profile.
- A string `model` renames the provider model. A model object or resolver uses the AI SDK path.
- `reasoningEffort` applies only to this run and needs an inherited Codex Driver.

Its usage is recorded as auxiliary usage on the run's usage record.
Generation times out after 20 seconds by default (`timeoutMs`). Finish hooks and cleanup can wait that long. Use `execute` to avoid a provider call.

## Inspect title generation

In a run's **Capabilities** tab, **Title** shows the generation state, title and method, model, length limit, timeout, trigger, and delivery mode. A custom `id` keeps the view.

Snapshots update during generation and stay after the run. Reading them generates nothing. The view follows configuration retention; `configuration: 'content'` keeps it apart from prompt and answer content.

## Requirements

- A text `prompt` or message input with at least one user message.
- Meaningful text from the input or a successful reply.
- A title `driver` must return text. `driver.ask` is not supported.
- `reasoningEffort` needs an inherited Codex Driver; others fail with `AGENT_R0924`.
- Provider Drivers, including one in `title({ driver })`, need a Node.js host. Cloudflare Worker builds fail with `AGENT_B0019`.

Use `template`, `variables`, or `execute` to add product context.

## Security and approval

`title()` adds no tool and has no `policy` option. The end user controls the source text:

- Model and Driver prompts get at most the last 8,000 characters, with Chat entity markup removed.
- A custom `execute` gets the full timed input and must limit it.
- The default prompt treats the source as data, not instructions.

> [!WARNING]
> An inherited provider title run has the main Driver's permissions. For less authority, use `execute`, a separate `driver`, or an AI SDK `model`.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Uses `model` or the Agent model. Decorates compatible output streams. |
| Provider-backed | Starts a title run through the inherited provider Driver unless `execute`, `driver`, or a non-string `model` overrides it. Decorates compatible output streams. |
| Custom-run-backed | No Agent model, so set `execute`, `driver`, or `model`, else the heuristic is used. Decorates compatible output; `driver.run` controls the shape. |

## Verify titles

1. Run once and find a `data-title` part or `title` data event in the stream.
2. In an `agent:finish` hook, check that `event.extensions.get('title')` returns `{ title }`.
3. With `execute: () => ''`, check the title is `fallback`, not empty.
4. Check the **Title** view in the Console.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `channelDelivery` | `"once-per-thread" \| "always"` | `"once-per-thread"` | Send managed Chat SDK Channel titles once per thread or every run. |
| `driver` | `AgentDriver` | none | Agent Driver used only for title generation. Must return text. |
| `execute` | `(input) => string \| { title?: string }` | none | Custom title generator. `input.source` is `"input"` or `"response"`. |
| `fallback` | `string` | `"Untitled"` | Used when there is no usable text, or an explicit `driver` fails. |
| `id` | `string` | `"title"` | Capability id and finish extension key. |
| `instructions` | `string` | none | System instructions for the AI SDK path, inherited provider run, and explicit model-backed `driver`. |
| `maxLength` | `number` | `39` | Maximum title length. |
| `model` | `AgentModelResolver` | Inherited provider Driver, else Agent model, then heuristic | A string renames the inherited provider model. An object or resolver uses the AI SDK path. |
| `reasoningEffort` | `string` | Inherited provider Driver setting | Only for the inherited Codex title run. Unset keeps the Driver's configuration, including environment settings. Not for an explicit `driver`, `execute`, or AI SDK model. |
| `template` | `string \| function` | generated | Prompt template. String templates can use `{{ message }}`, `{{ source }}`, `{{ fallback }}`, `{{ maxLength }}`, `{{ trigger }}`, and `variables`. |
| `timeoutMs` | `number` | `20_000` | Time limit; also respects run cancellation. |
| `trigger` | `string \| string[]` | all triggers | Only these Agent Trigger ids. |
| `variables` | `Record<string, value \| function>` | none | Extra template variables. |
| `when` | `(input) => boolean` | none | Decides whether generation runs. |

## Related pages

- [chat()](/docs/agents/capabilities/chat)
- [progressSummary()](/docs/agents/capabilities/progress-summary)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Channels](/docs/agents/channels)
- [Official Capabilities](/docs/agents/capabilities/official)
