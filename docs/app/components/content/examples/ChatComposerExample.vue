<script setup lang="ts">
import type { AgentChatPromptSubmit } from "@vite-hub/ui";
import type { ChatStatus, UIMessage } from "ai";
import { onBeforeUnmount, ref } from "vue";

const messages = ref<UIMessage[]>([]);
const input = ref("");
const status = ref<ChatStatus>("ready");
let timeout: ReturnType<typeof setTimeout> | undefined;

// A local echo replaces the transport. In an application, call `sendMessage()` from `useChat()`.
function submit({ text }: AgentChatPromptSubmit) {
  messages.value = [
    ...messages.value,
    { id: `user-${messages.value.length}`, role: "user", parts: [{ type: "text", text }] },
  ];
  input.value = "";
  status.value = "submitted";
  timeout = setTimeout(() => {
    messages.value = [
      ...messages.value,
      {
        id: `assistant-${messages.value.length}`,
        role: "assistant",
        parts: [{ type: "text", text: `You asked: **${text}**\n\nThis preview has no model, so it repeats the prompt.` }],
      },
    ];
    status.value = "ready";
  }, 700);
}

function stop() {
  clearTimeout(timeout);
  status.value = "ready";
}

onBeforeUnmount(() => clearTimeout(timeout));
</script>

<template>
  <AgentChat :messages="messages" :status="status" class="h-[26rem]">
    <template #composer>
      <p v-if="messages.length === 0" class="mb-3 text-center text-sm text-muted">
        Send a message to start the conversation.
      </p>
      <AgentChatPrompt
        v-model="input"
        :status="status"
        placeholder="Ask the Agent…"
        @submit="submit"
        @stop="stop"
      />
    </template>
  </AgentChat>
</template>
