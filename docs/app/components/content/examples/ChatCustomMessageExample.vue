<script setup lang="ts">
import type { UIMessage } from "ai";

const messages: UIMessage[] = [
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Summarize the last deploy." }],
  },
  {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "The deploy finished in **42 s**. All health checks passed." }],
  },
];
</script>

<template>
  <AgentChat :messages="messages" class="h-72">
    <template #message="{ message }">
      <div class="flex gap-3 py-2" :class="message.role === 'user' ? 'flex-row-reverse' : ''">
        <UAvatar
          :icon="message.role === 'user' ? 'i-lucide-user' : 'i-lucide-bot'"
          :alt="message.role === 'user' ? 'You' : 'Agent'"
          size="sm"
        />
        <AgentMessageParts
          :parts="message.parts"
          class="max-w-[80%] rounded-lg border border-default bg-default px-3 py-2 text-sm"
        />
      </div>
    </template>
  </AgentChat>
</template>
