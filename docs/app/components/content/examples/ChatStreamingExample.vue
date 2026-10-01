<script setup lang="ts">
import type { ChatStatus, UIMessage } from "ai";
import { onBeforeUnmount, ref } from "vue";

const reply =
  "The list used one fixed row height. Rows with an error description need a second line, so the next rows overlapped. Each row now reports its own height, and the list keeps cumulative offsets.";

const messages = ref<UIMessage[]>([
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Why do failed sessions overlap in the list?" }],
  },
]);
const status = ref<ChatStatus>("ready");
let timeout: ReturnType<typeof setTimeout> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;

// Simulate the states that `useChat()` reports while a response streams.
function streamReply() {
  if (status.value !== "ready") return;
  status.value = "submitted";
  const words = reply.split(" ");
  let count = 0;
  timeout = setTimeout(() => {
    status.value = "streaming";
    interval = setInterval(() => {
      count++;
      const done = count >= words.length;
      const text = words.slice(0, count).join(" ");
      messages.value = [
        messages.value[0]!,
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text, state: done ? "done" : "streaming" }],
        },
      ];
      if (done) {
        clearInterval(interval);
        status.value = "ready";
      }
    }, 60);
  }, 500);
}

onBeforeUnmount(() => {
  clearTimeout(timeout);
  clearInterval(interval);
});
</script>

<template>
  <div class="grid h-96 grid-rows-[minmax(0,1fr)_auto] gap-3">
    <AgentChat :messages="messages" :status="status" />
    <div class="flex items-center justify-between gap-3">
      <span class="font-mono text-xs text-muted">status: {{ status }}</span>
      <UButton
        label="Stream a reply"
        icon="i-lucide-play"
        color="neutral"
        variant="outline"
        size="sm"
        :disabled="status !== 'ready' || messages.length > 1"
        @click="streamReply"
      />
    </div>
  </div>
</template>
