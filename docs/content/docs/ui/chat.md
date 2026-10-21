---
title: Chat
description: Render an AI SDK message list that follows streaming output and keeps the reader's scroll position.
navigation.order: 20
navigation.group: Chat
icon: i-ph-chat-circle-text-light
---

`Chat` is the default Console conversation surface. It renders AI SDK `UIMessage[]` as a scrollable message log, follows a live reply while the reader is at the end, and leaves the reader in place when they scroll back through the run. Pair it with [`PromptInput`](/docs/ui/prompt-input) when the view accepts input.

::component-preview{name="ChatExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/chat`:

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

Give the chat a height, such as `h-dvh` or a grid row. The component fills that container and keeps the viewport scrollable inside it.

## Composition

`Chat` builds on the [Message Scroller](/docs/ui/message-scroller) parts. It renders one `ChatMessage` for each message, and each `ChatMessage` renders its parts with `MessageParts`.

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
- Follows a streaming reply while the reader stays at the end.
- Keeps the reader in place when they scroll back.
- Shows a scroll button that returns to the live edge.
- Does not send, stop, or regenerate messages. Your application owns the transport.

## AI SDK

Pass the reactive values from `useChat()`. The component does not call `sendMessage()`, `stop()`, or `regenerate()`, so the same UI works with AI SDK, ViteHub Agent routes, persisted sessions, or replayed fixtures.

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

ViteHub's `useChat()` wrapper from `vite-hub/agent/vue` returns the same values and adds the ViteHub route and typed Agent metadata.

## Streaming

The last message gets the `streaming` state while `status` is `submitted` or `streaming`. The log has `aria-busy="true"` during that time. Select **Stream a reply** and scroll up while it runs. The chat stops following, and the scroll control returns to the live edge when you use it.

::component-preview{name="ChatStreamingExample" reset}
::

## Composer and Empty State

Use the `composer` slot to place a prompt under the messages. The scroll control stays above it. Show an empty state from your own template when `messages` is empty.

::component-preview{name="ChatComposerExample" reset}
::

## Custom Message Layout

Use the `message` slot to replace the default `ChatMessage`. The slot receives `{ message, index }`. Reuse `MessageParts` inside it to keep the default part rendering.

::component-preview{name="ChatCustomMessageExample"}
::

## Accessibility

- The viewport is a keyboard-focusable region named **Messages**. The message list has `role="log"` and announces additions.
- The log is busy while a response is submitted or streaming, so screen readers do not announce partial text as final.
- The scroll button is a native button with an accessible name. It is inert at the live edge and moves focus back to the viewport when used.
- Reduced motion replaces smooth scrolling with instant scrolling.

## API Reference

### Chat

Renders a scrollable message log with one `ChatMessage` for each message.

#### Props

| Prop                | Type                   | Default           | Description                                                                  |
| ------------------- | ---------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `messages`          | `readonly UIMessage[]` | `[]`              | Messages to render, in order.                                                |
| `status`            | `ChatStatus`           | `"ready"`         | AI SDK chat status. `submitted` and `streaming` mark the last message as streaming. |
| `edgeThreshold`     | `number`               |                   | Distance in pixels that counts as the end. Falls back to the global default `8`. |
| `previousItemPeek`  | `number`               |                   | Pixels of the previous message that stay visible when a new user message scrolls into view. Falls back to the global default `64`. |
| `scrollButtonLabel` | `string`               | `"Scroll to end"` | Accessible name and default text of the scroll button.                       |

Other attributes go to the root element.

#### Slots

| Slot            | Scope                | Description                                                         |
| --------------- | -------------------- | ------------------------------------------------------------------- |
| `message`       | `{ message, index }` | Replaces the default `ChatMessage` for each message.                |
| `composer`      |                      | Content under the messages, for example `PromptInput`.              |
| `scroll-button` |                      | Content of the scroll button.                                       |
| `default`       |                      | Extra content inside the scroller root.                             |
| Other slots     |                      | Forwarded to each `ChatMessage`, for example `actions` or `tool`.   |

## Related

- [Chat message](/docs/ui/chat-message) renders one message.
- [Prompt input](/docs/ui/prompt-input) collects text and files.
- [Chat session](/docs/ui/chat-session) adds a title and session structure around the chat.
- [Message scroller](/docs/ui/message-scroller) gives the same scroll behavior without styles.
- [Chat app block](/docs/ui/blocks/chat-app) combines sessions, chat, and attachments.
