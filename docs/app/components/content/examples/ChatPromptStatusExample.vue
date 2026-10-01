<script setup lang="ts">
import type { ChatStatus } from "ai";
import { ref } from "vue";

const statuses: ChatStatus[] = ["ready", "submitted", "streaming", "error"];
const status = ref<ChatStatus>("streaming");
const input = ref("Draft the next question while the reply streams.");
const lastEvent = ref("");
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap gap-1" role="group" aria-label="Chat status">
      <UButton
        v-for="value in statuses"
        :key="value"
        :label="value"
        color="neutral"
        size="xs"
        :variant="status === value ? 'solid' : 'outline'"
        :aria-pressed="status === value"
        @click="status = value"
      />
    </div>
    <AgentChatPrompt
      v-model="input"
      :status="status"
      @submit="lastEvent = 'submit'"
      @stop="lastEvent = 'stop'"
      @reload="lastEvent = 'reload'"
    />
    <p class="font-mono text-xs text-muted">last event: {{ lastEvent || "none" }}</p>
  </div>
</template>
