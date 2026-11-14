---
title: Chat
description: Render an AI SDK message list that follows streaming output and keeps the reader's scroll position.
seo.title: Chat message list component for Vue
navigation.order: 20
navigation.group: Chat
icon: i-lucide-message-circle-more
---

`Chat` is the Console conversation view. It shows AI SDK `UIMessage[]` as a scrollable log. It follows a live reply while the reader is at the end, and stays in place when the reader scrolls back. Pair it with [`PromptInput`](/docs/ui/prompt-input) to accept input.

::example{name="ChatExample" height=28 flush}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { Chat } from "@vite-hub/ui";
```

## Usage

```ts
import { Chat } from "@vite-hub/ui";
```

```vue
<Chat :messages :status class="h-dvh" />
```

Give the chat a height, such as `h-dvh` or a grid row. It fills that space and scrolls inside it.

## Composition

`Chat` builds on the [Message Scroller](/docs/ui/message-scroller) parts. It renders one `ChatMessage` per message, and each renders its parts with `MessageParts`.

```text
Chat (MessageScroller)
├── MessageScrollerViewport
│   └── MessageScrollerContent
│       └── MessageScrollerItem, one for each message
│           └── ChatMessage, or the message slot
│               └── MessageParts
├── MessageScrollerButton, with the scroll-button slot
├── composer slot
└── default slot
```

## Features

- Renders AI SDK `UIMessage[]` and reads the AI SDK `ChatStatus`.
- A scroll button returns to the live edge.
- Does not send, stop, or regenerate messages. Your app handles the transport.

## AI SDK

Pass the values from `useChat()`. The component never calls `sendMessage()`, `stop()`, or `regenerate()`, so the same UI works with AI SDK, ViteHub Agent routes, saved sessions, or replayed fixtures.

```vue [app/pages/chat.vue]
<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import type { PromptInputSubmit } from "@vite-hub/ui";

const { messages, status, sendMessage, stop } = useChat();
const input = ref("");

function submit({ text, files }: PromptInputSubmit) {
  sendMessage({ text, files: [...files] });
  input.value = "";
}
</script>

<template>
  <Chat :messages :status class="h-dvh">
    <template #composer>
      <PromptInput v-model="input" :status @submit="submit" @stop="stop" />
    </template>
  </Chat>
</template>
```

`useChat()` from `vite-hub/agent/vue` returns the same values and adds the ViteHub route and typed Agent metadata.

## Streaming

While `status` is `submitted` or `streaming`, the last message is in the `streaming` state and the log has `aria-busy="true"`.

While a reply is coming and nothing shows progress, a quiet `Working` line with a static dot sits under the last message. This happens before the first part, after a message ends, and after a tool finishes. Streaming text, a running tool step, and live reasoning show their own progress, so the line hides then. Use the `status` slot to draw it yourself, or `chatActivity(messages, status)` for the same text in a custom layout.

Select **Stream a reply** and scroll up while it runs. The chat stops following. The scroll control returns to the live edge.

::example{name="ChatStreamingExample" reset height=24}
::

## Composer and Empty State

The `composer` slot puts a prompt under the messages, below the scroll control. Show your own empty state when `messages` is empty.

::example{name="ChatComposerExample" reset height=26}
::

## Custom Message Layout

The `message` slot replaces the default `ChatMessage` and receives `{ message, index }`. Use `MessageParts` inside it to keep the default part rendering.

::example{name="ChatCustomMessageExample" height=18}
::

## Accessibility

- The viewport is a focusable region named **Messages**. The list has `role="log"` and announces new messages.
- The log is busy while a response is submitted or streaming, so screen readers do not announce partial text as final.
- The scroll button is a named native button. It is inert at the live edge and moves focus to the viewport when used.
- With reduced motion, scrolling is instant.

## API Reference

### Chat

Renders a scrollable log with one `ChatMessage` per message.

#### Props

| Prop                | Type                   | Default           | Description                                                                  |
| ------------------- | ---------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `messages`          | `readonly UIMessage[]` | `[]`              | Messages to render, in order.                                                |
| `status`            | `ChatStatus`           | `"ready"`         | AI SDK chat status. `submitted` and `streaming` mark the last message as streaming. |
| `edgeThreshold`     | `number`               |                   | Pixels from the end that count as the end. Global default `8`. |
| `previousItemPeek`  | `number`               |                   | Pixels of the previous message kept visible when a new user message scrolls in. Global default `64`. |
| `scrollButtonLabel` | `string`               | `"Scroll to end"` | Scroll button name and default text. |

Other attributes go to the root element.

#### Slots

| Slot            | Scope                | Description                                                         |
| --------------- | -------------------- | ------------------------------------------------------------------- |
| `message`       | `{ message, index }` | Replaces the default `ChatMessage`. |
| `composer`      |                      | Content under the messages, such as `PromptInput`. |
| `scroll-button` |                      | Content of the scroll button.                                       |
| `status`        | `{ label }`          | Replaces the `Working` line. |
| `default`       |                      | Extra content inside the scroller root.                             |
| Other slots     |                      | Passed to each `ChatMessage`, such as `actions` or `tool`. |

## Related

- [Chat message](/docs/ui/chat-message) renders one message.
- [Prompt input](/docs/ui/prompt-input) collects text and files.
- [Chat session](/docs/ui/chat-session) adds a title and session layout around the chat.
- [Message scroller](/docs/ui/message-scroller) has the same scroll behavior without styles.
- [Chat app block](/docs/ui/blocks/chat-app) combines sessions, chat, and attachments.
