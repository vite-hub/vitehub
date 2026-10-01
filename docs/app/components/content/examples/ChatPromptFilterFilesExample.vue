<script setup lang="ts">
import type { FileUIPart } from "ai";
import { ref } from "vue";

const maxSize = 200 * 1024;
const input = ref("");
const files = ref<FileUIPart[]>([]);
const rejected = ref<string[]>([]);

// Keep files up to 200 KB. Return `[]` to reject the complete batch.
function filterFiles(batch: readonly File[]) {
  rejected.value = batch.filter((file) => file.size > maxSize).map((file) => file.name);
  return batch.filter((file) => file.size <= maxSize);
}
</script>

<template>
  <div class="space-y-3">
    <AgentChatPrompt
      v-model="input"
      v-model:files="files"
      accept="image/*,.txt,.log"
      :filter-files="filterFiles"
      placeholder="Attach or paste a file up to 200 KB…"
      status="ready"
    />
    <p v-if="rejected.length" class="text-xs text-muted" role="status">
      Too large: {{ rejected.join(", ") }}
    </p>
  </div>
</template>
