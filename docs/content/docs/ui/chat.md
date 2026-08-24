---
title: Chat
description: Render an AI SDK-native message list without coupling presentation to transport.
navigation.order: 10
navigation.group: Chat
icon: i-ph-chat-circle-text-light
---

`AgentChat` accepts AI SDK `UIMessage[]` and `ChatStatus`. It renders messages, preserves reader scroll intent during streaming, and exposes slots for application-specific presentation.

::component-preview{name="ChatExample" flush}
::

## Usage

```vue [app/pages/chat.vue]
<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import type { FileUIPart } from "ai";

const { messages, status, sendMessage, stop } = useChat();
const input = ref("");

function submit({ text, files }: { text: string; files: FileUIPart[] }) {
  sendMessage({ text, files });
  input.value = "";
}
</script>

<template>
  <div class="grid h-dvh grid-rows-[1fr_auto]">
    <AgentChat :messages :status />
    <AgentChatPrompt v-model="input" :status @submit="submit" @stop="stop" />
  </div>
</template>
```

ViteHub's `useChat()` wrapper has the same UI boundary and supplies the ViteHub route and typed Agent metadata.

## Anatomy

```vue
<AgentChat>
  <template #message="{ message, index }" />
  <template #scroll-button />
</AgentChat>
```

## Props

| Prop               | Type                   | Default             |
| ------------------ | ---------------------- | ------------------- |
| `messages`         | `readonly UIMessage[]` | `[]`                |
| `status`           | `ChatStatus`           | `'ready'`           |
| `edgeThreshold`    | `number`               | Global default `8`  |
| `previousItemPeek` | `number`               | Global default `64` |

The component does not call `sendMessage()`, `stop()`, or `regenerate()`. Keeping transport outside the rendering tree lets the same UI work with AI SDK, ViteHub Agent routes, persisted sessions, or replayed fixtures.
