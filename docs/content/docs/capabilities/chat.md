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

The Chat Capability turns message-shaped input into Agent Invocations and exposes the trigger to DevTools.
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

Open Agent DevTools and confirm the Agent exposes a `chat.message` trigger.
Send one DevTools message and verify the invocation origin, Chat Session behavior, and finish extension in the run details.

For adapter-backed delivery, inspect the Channel-generated webhook registrations for the expected route metadata.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hooks` | `AgentChatEventHooks` | none | Chat event hooks such as `onDirectMessage`. |
| `event` | `"directMessage"` | none | Chat event binding hint. |
| `triggerHistory` | `"none" \| { source: "thread"; maxMessages?: number }` | last 20 messages, or `threadHistory.maxMessages` when derived | Chat History Window sent into the `chat.message` Agent Trigger. |
| `threadHistory` | `{ maxMessages?: number; ttlMs?: number }` | inherited | Adapter thread backfill/cache; stores messages but does not by itself define model input. |
| `sessions` | `boolean \| AgentChatSessionOptions` | inherited | Chat Session behavior, including `strategy`, `idleTimeoutMs`, and `metadataKey`. |
| `state` | `AgentChatStateResolver` | runtime state | Chat State adapter override. |
| `stream` | `boolean` | inherited | Whether the chat trigger should stream output. |
| `concurrency` | `"drop" \| "parallel" \| "queue" \| "reject" \| string` | inherited | Message concurrency behavior. |
| `lockScope` | `"agent" \| "channel" \| "thread" \| string` | inherited | Scope used for message locks. |
| `fallbackStreamingPlaceholderText` | `string \| string[] \| null \| function` | inherited | Placeholder text while streaming starts. Arrays pick one entry per Agent Invocation; empty arrays skip the placeholder. |
| `errorFallbackText` | `string \| null \| function` | inherited | Fallback message when chat handling fails. |

## Reference

- [Agent triggers](/docs/agents/triggers)
- [chatTitle()](/docs/capabilities/chat-title)
- [chatSummary()](/docs/capabilities/chat-summary)
- Source: `packages/agent/src/chat-trigger.ts`
