---
title: chat()
description: Add chat-oriented Agent Trigger behavior and Chat History state requirements.
navigation.title: chat()
navigation.order: 20
icon: i-lucide-messages-square
---

`chat()` adds chat-oriented runtime behavior to an Agent Definition.
It contributes a `chat.message` Agent Trigger, optional Chat Platform Adapter webhooks, Chat History state requirements, and a chat finish extension.

## What it adds

The Chat Capability turns message-shaped input into Agent Invocations and exposes the trigger to DevTools.
When adapters are configured, the Agent Package can infer Chat Webhook Routes for supported platform events.

## Minimum attach example

Attach `chat()` when a chat surface should call the Agent through the Agent Trigger API.
The application UI or platform adapter remains the trigger consumer.

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
External Chat Platform Adapters remain explicit application dependencies.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives message-shaped input and can stream chat output through the model-backed path. |
| Harness-backed | Receives the prepared invocation input and chat context; harness-specific chat behavior depends on the harness adapter. |
| Custom-run-backed | Receives the chat trigger input and context; `driver.run` owns the response shape. |

## Inspect and verify

Open Agent DevTools and confirm the Agent exposes a `chat.message` trigger.
Send one DevTools message and verify the invocation origin, Chat Session behavior, and finish extension in the run details.

When adapters are configured, inspect generated webhook registrations for the expected platform names and route metadata.

## Reference

- [Agent triggers](/docs/agents/triggers)
- [chatTitle()](/docs/capabilities/chat-title)
- [chatSummary()](/docs/capabilities/chat-summary)
- Source: `packages/agent/src/chat-trigger.ts`
