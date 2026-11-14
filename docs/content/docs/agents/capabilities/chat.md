---
title: Chat
description: Let people chat with an Agent, keep Chat History, and send the final reply, without Channels.
seo.title: Chat capability for Agents
navigation.title: Chat
navigation.order: 120
navigation.group: Capabilities
icon: i-lucide-messages-square
---

`chat()` lets people chat with an Agent: each message starts an Invocation (one Agent run). It registers the `chat.message` Agent Trigger, asks for optional Chat History state, adds a chat finish extension (data read after the run), and sends the final reply. It adds no model tools unless you set `allowSilentReply`.

For message platforms, [Channels](/docs/agents/channels) accept messages and deliver replies.

## Configure chat

Attach `chat()` to start the Agent from a chat interface:

```ts [server/agents/support.ts] fragment
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

> [!WARNING]
> Using `chat()` with `defineAgent({ channels })` fails with a diagnostic.

With Channels, ViteHub adds the Chat Capability itself and reads these settings from `defineAgent({ messages })` and each Channel's `messages`. Use Channels for Slack, Telegram, Teams, web chat, or another adapter.

## How chat works

1. The `chat.message` trigger takes `ui-message[]` input and gives `ui-message-stream` output.
2. It builds the run input from the current message and the `triggerHistory` window.
3. During preparation, the Capability asks for optional Chat History state.
4. After the run, it gives chat finish data and sends the final reply. In a durable Agent Workflow, it also sends the error fallback text when the run fails.

`vitehub agent dev` uses the `chat.message` trigger by default.

## Requirements

- Chat History state is optional in local development. Configure an Agent State Provider when production needs durable sessions or concurrency coordination.
- You add external chat platform adapters yourself, through Channels.
- `chat()` does not accept `platforms`, `webhooks`, `meta`, or `metaRevision`. Set them on Channels.

## Security and approval

`chat()` has no `policy` option. Its only tool is `skip_reply`, added by `allowSilentReply`.

- Chat messages are untrusted model input.
- The final reply and error fallback text go back to the chat interface.
- Channel metadata added to the instructions (Channel, sender, username, send time) is labeled as context data, not instructions.
- To reject Channel messages before the run, use [`access({ chat })`](/docs/agents/capabilities/access) or `messages.filter`.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets message input and can stream chat output. |
| Provider-backed | Gets prepared input and chat context. The provider adapter decides chat behavior. |
| Custom-run-backed | Gets trigger input and context. `driver.run` owns the response shape. |

## Verify chat

1. Run `vitehub agent dev --agent <name> --prompt "hello"` and check that the Agent answers through `chat.message`.
2. Send a second message. Check the run origin, Chat Session, and finish extension in traces or run events.
3. For adapter delivery, check the route metadata in the Channel webhook registrations.

## Options

Delivery options match the Agent-level `messages` settings in [Channels](/docs/agents/channels).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hooks` | `AgentChatEventHooks` | none | Chat event hooks such as `onDirectMessage`. |
| `lifecycleHooks` | `Record<string, unknown>` | none | Lifecycle-hook settings for integrations that read this configuration. |
| `event` | `"directMessage"` | none | Chat event binding hint. |
| `triggerHistory` | `"none" \| { source: "thread"; maxMessages: number; maxAgeMs?: number; maxImages?: number }` | current message only | Chat History window sent to the trigger. `maxMessages` includes the current message. `maxImages` (default `0`) resends that many of the newest history images. |
| `timeZone` | `string` | `"UTC"` | IANA time zone for the send time in each [message header](/docs/agents/chat-history-sessions#what-the-model-reads). Invalid values use UTC. |
| `threadHistory` | `{ maxMessages?: number; ttlMs?: number }` | inherited | Adapter thread backfill and cache. Does not set model input. |
| `messageHistory` | Chat SDK message-history configuration | inherited | Passed to the Chat SDK. |
| `logger` | Chat SDK logger | inherited | Logger for adapter delivery. |
| `sessions` | `boolean \| AgentChatSessionOptions` | inherited | Chat Session behavior: `strategy` (`"manual"`, `"idle-timeout"`, or `"hybrid"`), `idleTimeoutMs`, and `metadataKey`. |
| `state` | `AgentChatStateResolver` | runtime state | Chat State adapter override. |
| `transcripts` | Chat SDK `TranscriptsConfig` | none | Transcript persistence for adapter-backed delivery. |
| `identity` | `IdentityResolver` | Channel-qualified user id when transcripts are enabled | Identity that partitions transcripts. |
| `filter` | `(context) => boolean` | none | Return `false` to drop a message before the run. Context has `message`, `deliveryKind`, and `thread.post`. |
| `stream` | `boolean` | inherited | Stream chat trigger output. |
| `streamingUpdateIntervalMs` | `number` | inherited | Minimum interval between streamed Channel message updates. |
| `commentary` | `"hidden" \| "message"` | `"hidden"` | Post Driver commentary phases as progress messages. Not with `loading` or manual delivery. |
| `concurrency` | `"drop" \| "parallel" \| "queue" \| "reject" \| "serial" \| "steer" \| string` | inherited | Overlapping messages. `serial` runs each kept message as its own run, in order. `queue` merges kept messages into one run. `steer` sends new input to the active run if its Driver supports live steering. Queue retention and failure guarantees come from the Chat State runtime. |
| `debounceMs` | `number` | none | Only with `concurrency: "steer"`. Wait this long after the first message, then start one run with all messages from that window. Without it, each message is handled at once. With durable Workflow delivery, later messages go to the active Workflow. An inline run holds the Chat SDK lock until it ends, so messages during it start the next run instead of steering. |
| `steerFromParticipants` | `boolean` | `false` | Only with inline `concurrency: "steer"`. Another human's message in the thread steers the active run, which keeps the first invoker. See [Steer with other participants](/docs/agents/channels#steer-with-other-participants). |
| `lockScope` | `"agent" \| "channel" \| "thread" \| string` | inherited | Scope for message locks. |
| `dedupeTtlMs` | `number` | inherited | TTL for duplicate-message keys. |
| `userName` | `string` | `"vitehub"` | Agent username for adapter delivery. |
| `fallbackStreamingPlaceholderText` | `string \| string[] \| null \| function` | inherited | Placeholder while streaming starts. An array picks one entry per run; an empty array skips it. |
| `loading` | `{ text: string \| string[] \| null \| function; updates?: "commentary"; intervalMs?: number }` | none | Post a loading message, replaced by the final text. Not with `stream` or `commentary`. `intervalMs` must be positive. |
| `delivery` | `"automatic" \| "manual"` | `"automatic"` | `"manual"` posts no final text; finish hooks reply with `event.reply()`. Not with `stream` or `commentary`. |
| `final` | `{ delivery: "new-message" }` | inherited | Post the final reply as a new message, then remove the loading message. |
| `allowSilentReply` | `boolean` | `false` | Add a `skip_reply` tool. Calling it ends the run with no final reply and removes the loading message. The trace records a skipped `chat.final-reply` effect with the reason. Requires `loading` without `delivery: "manual"`. |
| `timeout` | `number` | none | Positive limit in milliseconds for inline runs and the durable handoff's typing indicator. |
| `wrapUp` | `false \| { beforeMs?: number; prompt?: string }` | on for a `timeout` of 5 minutes or more | `beforeMs` (default 2 minutes) before `timeout` cancels an inline run, steer it to reply with what it found. Needs a Driver that accepts mid-turn steering, such as Provider Drivers; otherwise only the timeout applies. `false` turns it off. |
| `durable` | `boolean` | inherited | Carry the reply across a durable Workflow boundary. Requires `loading` or `delivery: "manual"`, and `concurrency: "parallel"` or `"steer"`. |
| `errorFallbackText` | `string \| null \| function` | inherited | Message sent when chat handling fails. A function gets `error`, `publicError`, `invocation` (`{ id, consoleUrl? }` when the error belongs to a run), and `defaultText`, the text sent when this is unset. |
| `consoleLink` | `boolean` | `false` | For internal users, link the run in the Console. Error replies end with `Details: <Console URL>`, also after custom `errorFallbackText`. An inline `loading` message ends with `[Details](<Console URL>)`, kept when `updates: "commentary"` replaces the text. No link when the run is unknown or no [public URL](/docs/development/integrations-and-output#public-url) is set, and no error link when the reply has the URL. Keep it off for external users: the link shows internal details. Durable Workflow error replies and loading messages have no link yet. |

## Related pages

- [Channels](/docs/agents/channels)
- [Agent triggers](/docs/agents/triggers)
- [Chat History and sessions](/docs/agents/chat-history-sessions)
- [access()](/docs/agents/capabilities/access)
- [title()](/docs/agents/capabilities/title)
- [Official Capabilities](/docs/agents/capabilities/official)
