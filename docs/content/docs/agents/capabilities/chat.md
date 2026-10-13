---
title: Chat
description: Add the chat.message Agent Trigger, Chat History state, and chat finish behavior to an Agent without Channels.
navigation.title: Chat
navigation.order: 120
navigation.group: Capabilities
icon: i-lucide-messages-square
---

`chat()` adds chat behavior to an Agent Definition. It registers the `chat.message` Agent Trigger, requests optional Chat History state, and adds a chat finish extension and final reply delivery. It adds no model-facing tools.

The Chat Capability turns message-shaped input into Agent Invocations and exposes the trigger to the CLI Dev Loop. [Channels](/docs/agents/channels) own route admission and delivery for message platforms.

## Configure chat

Attach `chat()` to call the Agent from a chat interface through the Agent Trigger API.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { chat } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    chat({
      triggerHistory: { source: 'thread', maxMessages: 10 },
    }),
  ],
})
```

Do not combine `chat()` with `defineAgent({ channels })`. That fails with a diagnostic. When an Agent has Channels, ViteHub adds the Chat Capability itself and reads the same settings from `defineAgent({ messages })` and from each Channel's `messages`. Use Channels to deliver messages from Slack, Telegram, Teams, web chat, or another adapter.

## How chat works

`chat()` registers the `chat.message` trigger with `ui-message[]` input and `ui-message-stream` output. The trigger builds the Agent Invocation input from the current message and the configured `triggerHistory` window.

During preparation, the Capability requests Chat History state as an optional requirement. After the Agent Invocation completes, it provides chat finish data and delivers the final reply. In a durable Agent Workflow, it also delivers the error fallback text when the invocation fails.

`vitehub agent dev` uses the `chat.message` trigger by default when the Agent has one.

## Requirements

- Chat History state is optional in local development. Configure an Agent State Provider when the deployed stack needs durable sessions or concurrency coordination.
- External Chat Platform Adapters are explicit application dependencies that you configure through Channels.
- `chat()` does not accept `platforms`, `webhooks`, `meta`, or `metaRevision`. Configure them on Channels.

## Security and approval

`chat()` adds no model-facing tool and has no `policy` option.

- Chat messages come from end users of the chat interface. Treat them as untrusted model input.
- The final reply and the error fallback text go back to the chat interface.
- When ViteHub adds Channel message metadata (Channel, sender, username, and send time) to the instructions, it labels the values as context data, not instructions.
- For Channel traffic, use [`access({ chat })`](/docs/agents/capabilities/access) or `messages.filter` to reject messages before an Agent Invocation starts.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives message-shaped input and can stream chat output. |
| Provider-backed | Receives the prepared invocation input and chat context. Provider chat behavior follows the provider adapter. |
| Custom-run-backed | Receives the chat trigger input and context. `driver.run` owns the response shape. |

## Verify chat

1. Run `vitehub agent dev --agent <name> --prompt "hello"` and confirm that the Agent responds through the `chat.message` trigger.
2. Send a second message and verify the invocation origin, Chat Session behavior, and finish extension through traces or run events.
3. For adapter-backed delivery, inspect the Channel webhook registrations for the expected route metadata.

## Options

The delivery options below match the Agent-level `messages` settings that [Channels](/docs/agents/channels) describe.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hooks` | `AgentChatEventHooks` | none | Chat event hooks such as `onDirectMessage`. |
| `lifecycleHooks` | `Record<string, unknown>` | none | Lifecycle-hook settings for integrations that read Chat Capability configuration. |
| `event` | `"directMessage"` | none | Chat event binding hint. |
| `triggerHistory` | `"none" \| { source: "thread"; maxMessages: number; maxAgeMs?: number }` | current message only | Bounded Chat History Window sent into the `chat.message` Agent Trigger. `maxMessages` includes the current message. |
| `threadHistory` | `{ maxMessages?: number; ttlMs?: number }` | inherited | Adapter thread backfill and cache. Stores messages but does not define model input. |
| `messageHistory` | Chat SDK message-history configuration | inherited | Adapter message-history behavior passed to the Chat SDK. |
| `logger` | Chat SDK logger | inherited | Logger passed to adapter-backed Chat SDK delivery. |
| `sessions` | `boolean \| AgentChatSessionOptions` | inherited | Chat Session behavior: `strategy` (`"manual"`, `"idle-timeout"`, or `"hybrid"`), `idleTimeoutMs`, and `metadataKey`. |
| `state` | `AgentChatStateResolver` | runtime state | Chat State adapter override. |
| `transcripts` | Chat SDK `TranscriptsConfig` | none | Transcript persistence for adapter-backed delivery. |
| `identity` | `IdentityResolver` | Channel-qualified user id when transcripts are enabled | Resolve the identity that partitions transcripts. |
| `filter` | `(context) => boolean` | none | Return `false` to drop a message before an Agent Invocation starts. The context has `message`, `deliveryKind`, and `thread.post`. |
| `stream` | `boolean` | inherited | Stream chat trigger output. |
| `streamingUpdateIntervalMs` | `number` | inherited | Minimum interval between streamed Channel message updates. |
| `commentary` | `"hidden" \| "message"` | `"hidden"` | Publish explicit Driver commentary phases as progress messages. Cannot be combined with `loading` or manual delivery. |
| `concurrency` | `"drop" \| "parallel" \| "queue" \| "reject" \| "serial" \| "steer" \| string` | inherited | Overlapping message behavior. `serial` runs each retained message as a separate awaited Agent Invocation in queue order. `queue` coalesces retained messages into one invocation. `steer` sends overlapping input to the active Agent Invocation when its Driver supports live steering. Queue retention and failure guarantees come from the configured Chat State runtime. |
| `lockScope` | `"agent" \| "channel" \| "thread" \| string` | inherited | Scope for message locks. |
| `dedupeTtlMs` | `number` | inherited | Time-to-live for Chat SDK duplicate-message keys. |
| `userName` | `string` | `"vitehub"` | Agent username for adapter-backed Chat SDK delivery. |
| `fallbackStreamingPlaceholderText` | `string \| string[] \| null \| function` | inherited | Placeholder text while streaming starts. An array picks one entry per Agent Invocation. An empty array skips the placeholder. |
| `loading` | `{ text: string \| string[] \| null \| function; updates?: "commentary"; intervalMs?: number }` | none | Post a loading message and replace it with the final text when the Agent finishes. Cannot be combined with `stream` or `commentary`. `intervalMs` must be a positive number. |
| `delivery` | `"automatic" \| "manual"` | `"automatic"` | `"manual"` posts no final text. Finish hooks own all replies with `event.reply()`. Cannot be combined with `stream` or `commentary`. |
| `final` | `{ delivery: "new-message" }` | inherited | Post the final reply as a new message before removing the loading message. |
| `timeout` | `number` | none | Positive time limit in milliseconds for inline execution and the durable handoff's typing indicator. |
| `durable` | `boolean` | inherited | Carry the reply across a durable Workflow boundary. Requires `loading` or `delivery: "manual"`. Allows only `concurrency: "parallel"` or `"steer"`. |
| `errorFallbackText` | `string \| null \| function` | inherited | Message sent when chat handling fails. A function receives `error`, `publicError`, `invocation`, and `defaultText`, the text ViteHub sends when this option is not set. `invocation` is `{ id, consoleUrl? }` when the error belongs to a run. |
| `errorConsoleLink` | `boolean` | `false` | Add `Details: <Console URL>` of the failed Invocation to the end of each error reply, also after custom `errorFallbackText`. ViteHub adds no link when the reply already contains the URL, when the run is unknown, or when no [public URL](/docs/development/integrations-and-output#public-url) is set. Keep it off for external users, because the link shows internal details. Durable Workflow error replies do not have the link yet. |

## Related pages

- [Channels](/docs/agents/channels)
- [Agent triggers](/docs/agents/triggers)
- [Chat History and sessions](/docs/agents/chat-history-sessions)
- [access()](/docs/agents/capabilities/access)
- [title()](/docs/agents/capabilities/title)
- [chatSummary()](/docs/agents/capabilities/chat-summary)
- [Official Capabilities](/docs/agents/capabilities/official)
