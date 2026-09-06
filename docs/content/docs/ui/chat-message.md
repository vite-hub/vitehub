---
title: Chat Message
description: Render one AI SDK UI message through Nuxt UI and customizable part slots.
navigation.order: 11
navigation.group: Chat
icon: i-ph-chat-text-light
---

`AgentChatMessage` composes Nuxt UI's `UChatMessage` with `AgentMessageParts`.

::component-preview{name="ChatMessageExample"}
::

## Usage

```vue
<AgentChatMessage :message="message" :streaming="status === 'streaming'">
  <template #actions="{ message }">
    <UButton icon="i-lucide-copy" variant="ghost" @click="copy(message)" />
  </template>
</AgentChatMessage>
```

## Slots

| Slot       | Scope             | Purpose                                            |
| ---------- | ----------------- | -------------------------------------------------- |
| `default`  | `{ message }`     | Replace the complete message body.                 |
| `header`   | `{ message }`     | Add files or message metadata above the body.      |
| `leading`  | `{ message }`     | Replace the avatar or role marker.                 |
| `actions`  | `{ message }`     | Add copy, retry, feedback, or application actions. |
| Part slots | `{ part, index }` | Forwarded to `AgentMessageParts`.                  |

Use the `ui` prop to pass Nuxt UI slot classes to the underlying `UChatMessage`.
