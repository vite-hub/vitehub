<script setup lang="ts">
import type { FileUIPart } from "ai";
import { ref } from "vue";
import { PromptInput } from "../prompt-input/index.ts";

const text = ref("");
const files = ref<readonly FileUIPart[]>([]);
const sent = ref("");
</script>

<template>
  <div data-slot="example-prompt-input" style="display: flex; flex-direction: column; gap: 0.5rem; max-width: 32rem">
    <PromptInput
      v-model="text"
      v-model:files="files"
      accept="image/*,.txt"
      placeholder="Ask the Agent…"
      @submit="sent = $event.text"
    />
    <p data-slot="example-prompt-input-sent" role="status">{{ sent ? `Sent: ${sent}` : "Nothing sent yet." }}</p>
  </div>
</template>
