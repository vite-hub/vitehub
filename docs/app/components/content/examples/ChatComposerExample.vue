<script setup lang="ts">
import type { AgentChatPromptSubmit } from "@vite-hub/ui";
import type { ChatStatus, UIMessage } from "ai";
import { onBeforeUnmount, ref } from "vue";

const messages = ref<UIMessage[]>([]);
const input = ref("");
const status = ref<ChatStatus>("ready");
let timeout: ReturnType<typeof setTimeout> | undefined;

// The preview uses a local reply. In an application, call `sendMessage()` from `useChat()`.
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
        parts: [{ type: "text", text: `I would look for **${text}** in the selected Agent run and link the relevant activity here.\n\nThis fixture keeps the transport out of the component example.` }],
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
        Ask about the selected run, a file, or the next action.
      </p>
      <AgentChatPrompt
        v-model="input"
        :status="status"
        placeholder="Ask about this run…"
        @submit="submit"
        @stop="stop"
      />
    </template>
  </AgentChat>
</template>
