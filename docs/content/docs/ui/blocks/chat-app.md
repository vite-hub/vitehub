---
title: Chat App
description: "A complete chat layout with a session list, streamed replies, and a prompt with attachments."
navigation.order: 10
navigation.group: Blocks
icon: i-lucide-messages-square
---

This block combines a session list, [`ChatSession`](/docs/ui/chat-session), and [`PromptInput`](/docs/ui/prompt-input) with attachments. Select a session, send a message, or attach a log file. The sessions and replies are fake. No model runs and no requests leave the page.

::example{name="ChatAppBlock" flush reset height=36}
::

Below 42rem wide, the session list moves above the chat. Sending, stopping, and switching sessions all work in the preview.

## Connect a real transport

Move the chat pane into a child component keyed by the session ID, so each session gets its own `useChat()` state. Replace the fake `submit()` and `stop()` with the chat helpers.

```vue [SessionPane.vue]
<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import type { PromptInputSubmit, ViteHubUISession } from "@vite-hub/ui";
import type { FileUIPart } from "ai";

const props = defineProps<{ session: ViteHubUISession }>();
const { messages, status, sendMessage, stop } = useChat({
  id: props.session.id,
  messages: [...props.session.messages],
});
const input = ref("");
const files = ref<FileUIPart[]>([]);

function submit({ text, files: attached }: PromptInputSubmit) {
  sendMessage({ text, files: [...attached] });
  input.value = "";
  files.value = [];
}
</script>

<template>
  <ChatSession :session="{ ...session, messages }" :status>
    <template #composer>
      <PromptInput v-model="input" v-model:files="files" :status @submit="submit" @stop="stop" />
    </template>
  </ChatSession>
</template>
```

```vue
<SessionPane :key="selected.id" :session="selected" />
```

Load and save sessions in your own storage. The components store nothing.

## What to keep

- The prompt, or its pane, has a `:key` with the session ID. Changing sessions unmounts it, so a pending file read cannot write into another session.
- Your app clears `input` and `files` after a send. The prompt keeps the draft when a send is blocked.
- The session list is a `<nav>` with `aria-current` on the selected session.

## Components used

- [Chat session](/docs/ui/chat-session)
- [Chat](/docs/ui/chat)
- [Prompt input](/docs/ui/prompt-input)
- [Message parts](/docs/ui/message-parts)
