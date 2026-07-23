---
title: Channels API
description: Understand message-shaped Agent Invocations, Channel metadata, chat state, and host-owned commands.
navigation.order: 9
icon: i-lucide-message-square
---

The Channels API names message-shaped reachability without turning delivery metadata into trusted identity. It keeps Channel facts, message input, chat state, and host-owned commands separate.

Message-shaped input is one way to start an Agent Invocation. ViteHub keeps it separate from the Agent itself: an Agent can receive plain prompts, structured input, or messages depending on the trigger and Capability behavior.

Channel definitions own Agent admission and delivery facts, while `routes.chat` on `hubAgent()` owns whether the host publishes a chat dispatcher. Chat state owns conversation history and session selection. The `chat.message` trigger is the shared message-shaped entry point that both the generated dispatcher and app-owned trigger consumers can use.

## Message-shaped invocation

Set `routes.chat` on `hubAgent()` to publish the generated dispatcher. `webChat()` admits an Agent by default once that dispatcher exists, while `webChat({ route })` customizes admission and input mapping; application code should not import generated route handler factories.

Application routes can consume the same trigger directly when the app owns the chat UI.

```ts [server/api/support-chat.post.ts]
import { runAgentTrigger } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text: string }>(event)

  return runAgentTrigger(support, { runtime: 'vite' }, 'chat.message', {
    messages: [{
      id: crypto.randomUUID(),
      parts: [{ text: body.text, type: 'text' }],
      role: 'user',
    }],
  })
})
```

## Message concepts

| Concept | Meaning |
| --- | --- |
| Channel | Host or integration entry surface with origin, admission, and delivery facts, such as an app chat, GitHub thread, or external platform conversation. |
| Agent Invocation | One runtime request to an Agent. It may or may not be message-shaped. |
| Message | A normalized chat-style record with a role and parts such as text, tool calls, approvals, data, audio, sources, or errors. |
| Chat History | Ordered conversational messages for one chat interaction. |
| Chat History Window | The bounded prior messages included in one Agent Invocation. |
| Chat Session | A host-visible conversation boundary inside Chat History. |
| Agent Run metadata | Host-provided metadata such as origin, run id, thread id, or channel id. |

## Commands are not all the same

Input Commands are Capability behavior that transforms or enriches explicit user input before the Agent runs. Host Commands change chat, session, UI, or product state around an Agent and stay outside the Capability Lifecycle.

For example, a summary command can be an Input Command when it produces Agent run input. A `/clear` chat action is a Host Command because it mutates host chat state.

## Inspect it

Inspect the trigger id, normalized messages, and Agent Run metadata through traces or run events. Server routes can also log the exact trigger input they pass to `runAgentTrigger()`.

## Next steps

- Read [Channels](/docs/agents/channels) for the Agent-level implementation boundary.
- Read [Triggers](/docs/agents/triggers).
- Read [Agent Invocations](/docs/agents/invocations).
- Read [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) when chat identity should become trusted invocation identity.
