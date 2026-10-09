---
title: Chat App
description: "A complete chat layout with a session list, streamed replies, and a prompt with attachments."
navigation.order: 10
navigation.group: Console
icon: i-ph-chats-teardrop-light
---

This block combines a session list, [`AgentSession`](/docs/ui/session), and [`AgentChatPrompt`](/docs/ui/chat-prompt) with attachments. Select a session, send a message, or attach a log file. The sessions and streamed replies are synthetic. No model runs and no network requests leave the page.

::component-preview{name="ChatAppBlock" flush reset}
::

The session list moves above the chat when the block is narrower than 42rem. Sending a message, stopping a reply, and switching sessions all work in the preview.

## Connect a real transport

Move the chat pane into a child component and key it by the session ID, so each session gets its own `useChat()` state. Replace the synthetic `submit()` and `stop()` with the chat helpers.

```vue [SessionPane.vue]
<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import type { AgentChatPromptSubmit, ViteHubUISession } from "@vite-hub/ui";
import type { FileUIPart } from "ai";

const props = defineProps<{ session: ViteHubUISession }>();
const { messages, status, sendMessage, stop } = useChat({
  id: props.session.id,
  messages: [...props.session.messages],
});
const input = ref("");
const files = ref<FileUIPart[]>([]);

function submit({ text, files: attached }: AgentChatPromptSubmit) {
  sendMessage({ text, files: [...attached] });
  input.value = "";
  files.value = [];
}
</script>

<template>
  <AgentSession :session="{ ...session, messages }" :status>
    <template #composer>
      <AgentChatPrompt v-model="input" v-model:files="files" :status @submit="submit" @stop="stop" />
    </template>
  </AgentSession>
</template>
```

```vue
<SessionPane :key="selected.id" :session="selected" />
```

Load and save sessions in your own storage. The components do not persist anything.

## What to keep

- The prompt, or the pane that contains it, has a `:key` with the session ID. Changing sessions unmounts it, so a pending file read cannot write into another session.
- The application clears `input` and `files` after a send. The prompt keeps the draft when a send is blocked.
- The session list is a `<nav>` with `aria-current` on the selected session.

## Components used

- [Session](/docs/ui/session)
- [Chat](/docs/ui/chat)
- [Chat prompt](/docs/ui/chat-prompt)
- [Message parts](/docs/ui/message-parts)
