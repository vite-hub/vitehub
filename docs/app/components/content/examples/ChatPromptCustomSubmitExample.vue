<script setup lang="ts">
import { ref } from "vue";

const input = ref("");
const sent = ref<string[]>([]);
</script>

<template>
  <div class="space-y-3">
    <AgentChatPrompt
      v-model="input"
      placeholder="Write a release note…"
      status="ready"
      @submit="sent.push($event.text); input = ''"
    >
      <template #submit="{ canSubmit, preparingFiles }">
        <UButton
          type="submit"
          label="Publish"
          trailing-icon="i-lucide-arrow-up"
          color="neutral"
          size="sm"
          :loading="preparingFiles"
          :disabled="!canSubmit"
        />
      </template>
    </AgentChatPrompt>
    <ul v-if="sent.length" class="space-y-1 text-xs text-muted">
      <li v-for="(text, index) in sent" :key="index">Published: {{ text }}</li>
    </ul>
  </div>
</template>
