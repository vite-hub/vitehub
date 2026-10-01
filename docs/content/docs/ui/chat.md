---
title: Chat
description: Render an AI SDK message list that follows streaming output and keeps the reader's scroll position.
navigation.order: 10
navigation.group: Chat
icon: i-ph-chat-circle-text-light
---

`AgentChat` renders AI SDK `UIMessage[]` as a scrollable message log. It follows streaming output while the reader stays at the end, and it stops following when the reader scrolls up. Use it for any chat surface. Pair it with [`AgentChatPrompt`](/docs/ui/chat-prompt) for input.

::component-preview{name="ChatExample"}
::

## Usage

Pass the reactive values from `useChat()`. The component does not call `sendMessage()`, `stop()`, or `regenerate()`, so the same UI works with AI SDK, ViteHub Agent routes, persisted sessions, or replayed fixtures.

```vue [app/pages/chat.vue]
<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import type { AgentChatPromptSubmit } from "@vite-hub/ui";

const { messages, status, sendMessage, stop } = useChat();
const input = ref("");

function submit({ text, files }: AgentChatPromptSubmit) {
  sendMessage({ text, files: [...files] });
  input.value = "";
}
</script>

<template>
  <AgentChat :messages :status class="h-dvh">
    <template #composer>
      <AgentChatPrompt v-model="input" :status @submit="submit" @stop="stop" />
    </template>
  </AgentChat>
</template>
```

ViteHub's `useChat()` wrapper from `vite-hub/agent/vue` returns the same values and adds the ViteHub route and typed Agent metadata.

Give the chat a height, for example `h-dvh` or a grid row. The viewport scrolls inside that height.

## Examples

### Streaming

The last message gets the `streaming` state while `status` is `submitted` or `streaming`. The log has `aria-busy="true"` during that time. Select **Stream a reply** and scroll up while it runs: the chat stops following, and the scroll button returns to the end.

::component-preview{name="ChatStreamingExample" reset}
::

### Composer and empty state

Use the `composer` slot to place a prompt under the messages. The scroll button moves up to stay above the composer. Show an empty state from your own template when `messages` is empty.

::component-preview{name="ChatComposerExample" reset}
::

### Custom message layout

Use the `message` slot to replace the default `AgentChatMessage`. The slot receives `{ message, index }`. Reuse `AgentMessageParts` inside it to keep the default part rendering.

::component-preview{name="ChatCustomMessageExample"}
::

## API reference

### AgentChat

#### Props

| Prop                | Type                   | Default           | Description                                                                  |
| ------------------- | ---------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `messages`          | `readonly UIMessage[]` | `[]`              | Messages to render, in order.                                                |
| `status`            | `ChatStatus`           | `'ready'`         | AI SDK chat status. `submitted` and `streaming` mark the last message as streaming. |
| `edgeThreshold`     | `number`               |                   | Distance in pixels that counts as the end. Falls back to the global default `8`. |
| `previousItemPeek`  | `number`               |                   | Pixels of the previous message that stay visible when a new user message scrolls into view. Falls back to the global default `64`. |
| `scrollButtonLabel` | `string`               | `'Scroll to end'` | Accessible name and default text of the scroll button.                       |

Other attributes go to the root element.

#### Slots

| Slot            | Scope                | Description                                                         |
| --------------- | -------------------- | ------------------------------------------------------------------- |
| `message`       | `{ message, index }` | Replaces the default `AgentChatMessage` for each message.           |
| `composer`      |                      | Content under the messages, for example `AgentChatPrompt`.          |
| `scroll-button` |                      | Content of the scroll button.                                       |
| `default`       |                      | Extra content inside the scroller root.                             |
| Other slots     |                      | Forwarded to each `AgentChatMessage`, for example `actions` or `tool`. |

## Accessibility

- The viewport is a keyboard-focusable region named **Messages**. The message list has `role="log"` and announces additions.
- The log is busy while a response is submitted or streaming, so screen readers do not announce partial text as final.
- The scroll button is a native button with an accessible name. It is inert at the live edge and moves focus back to the viewport when used.
- Reduced motion replaces smooth scrolling with instant scrolling.

## Related

- [Chat message](/docs/ui/chat-message) renders one message.
- [Chat prompt](/docs/ui/chat-prompt) collects text and files.
- [Session](/docs/ui/session) adds a title and session structure around the chat.
- [Message scroller](/docs/ui/message-scroller) gives the same scroll behavior without styles.
- [Chat app block](/docs/ui/blocks/chat-app) combines sessions, chat, and attachments.
