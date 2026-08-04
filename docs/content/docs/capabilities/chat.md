---
title: Chat
description: Add chat-oriented Agent Trigger behavior and Chat History state requirements.
navigation.title: Chat
navigation.order: 20
navigation.group: Invocation
icon: i-lucide-messages-square
---

`chat()` adds chat-oriented runtime behavior to an Agent Definition.
It contributes a `chat.message` Agent Trigger, Chat History state requirements, and a chat finish extension.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Chat Capability turns message-shaped input into Agent Invocations and exposes the trigger to the CLI Dev Loop.
Message-shaped Channels own route admission and delivery into that trigger.

## Configuration

Attach `chat()` when a chat surface should call the Agent through the Agent Trigger API.
Use [Channels](/docs/agents/channels) when Slack, Telegram, Teams, web chat, or another adapter-backed surface should deliver messages.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { chat } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    chat(),
  ],
})
```

## Runtime behavior

`chat()` registers the `chat.message` trigger with `ui-message[]` input and `ui-message-stream` output.
It prepares Chat History state when available, records chat context, and provides chat finish data after the Agent Invocation completes.

## Requirements

Chat History state is optional in local development but needs an Agent State Provider when the deployed stack requires durable sessions or concurrency coordination.
External Chat Platform Adapters remain explicit application dependencies configured through Channels.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives message-shaped input and can stream chat output through the model-backed path. |
| Harness-backed | Receives the prepared invocation input and chat context; harness-specific chat behavior depends on the harness adapter. |
| Custom-run-backed | Receives the chat trigger input and context; `driver.run` owns the response shape. |

## Inspect and verify

Run `vitehub agent dev --agent <name> --prompt "hello"` and confirm the Agent responds through the configured Chat Capability.
Send one message through `vitehub agent dev` and verify the invocation origin, Chat Session behavior, and finish extension through traces or run events.

For adapter-backed delivery, inspect the Channel-generated webhook registrations for the expected route metadata.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hooks` | `AgentChatEventHooks` | none | Chat event hooks such as `onDirectMessage`. |
| `lifecycleHooks` | `Record<string, unknown>` | none | Additional lifecycle-hook settings for integrations that consume Chat Capability configuration. |
| `event` | `"directMessage"` | none | Chat event binding hint. |
| `triggerHistory` | `"none" \| { source: "thread"; maxMessages?: number }` | last 20 messages, or `threadHistory.maxMessages` when derived | Chat History Window sent into the `chat.message` Agent Trigger. |
| `threadHistory` | `{ maxMessages?: number; ttlMs?: number }` | inherited | Adapter thread backfill/cache; stores messages but does not by itself define model input. |
| `messageHistory` | Chat SDK message-history configuration | inherited | Adapter message-history behavior passed to the Chat SDK. |
| `logger` | Chat SDK logger | inherited | Logger passed to adapter-backed Chat SDK delivery. |
| `sessions` | `boolean \| AgentChatSessionOptions` | inherited | Chat Session behavior, including `strategy`, `idleTimeoutMs`, and `metadataKey`. |
| `state` | `AgentChatStateResolver` | runtime state | Chat State adapter override. |
| `transcripts` | Chat SDK `TranscriptsConfig` | none | Transcript persistence configuration for adapter-backed Channels. |
| `identity` | `IdentityResolver` | channel-qualified user id when transcripts are enabled | Resolve the identity used to partition transcripts. |
| `stream` | `boolean` | inherited | Whether the chat trigger should stream output. |
| `streamingUpdateIntervalMs` | `number` | inherited | Minimum interval between streamed Channel message updates. |
| `concurrency` | `"drop" \| "parallel" \| "queue" \| "reject" \| "serial" \| string` | inherited | Overlapping message behavior. `serial` runs each retained message as a separate awaited Agent Invocation in queue order; `queue` coalesces retained messages into one invocation. Queue retention and failure guarantees come from the configured Chat State runtime. |
| `lockScope` | `"agent" \| "channel" \| "thread" \| string` | inherited | Scope used for message locks. |
| `dedupeTtlMs` | `number` | inherited | Time-to-live for Chat SDK duplicate-message keys. |
| `userName` | `string` | `"vitehub"` | Agent username used by adapter-backed Chat SDK delivery. |
| `fallbackStreamingPlaceholderText` | `string \| string[] \| null \| function` | inherited | Placeholder text while streaming starts. Arrays pick one entry per Agent Invocation; empty arrays skip the placeholder. |
| `errorFallbackText` | `string \| null \| function` | inherited | Fallback message when chat handling fails. |

## Reference

- [Agent triggers](/docs/agents/triggers)
- [Chat History and sessions](/docs/agents/chat-history-sessions)
- [title()](/docs/capabilities/title)
- [chatSummary()](/docs/capabilities/chat-summary)
- Source: `packages/agent/src/chat-trigger.ts`
