<script setup lang="ts">
import type { FileUIPart } from "ai";
import { ref } from "vue";

const input = ref("Check the failed invocation and explain the cause.");
const files = ref<FileUIPart[]>([
  {
    type: "file",
    filename: "invocation.log",
    mediaType: "text/plain",
    url: "data:text/plain,Agent%20invocation%20failed",
  },
]);
const submitted = ref("");
</script>

<template>
  <div class="space-y-3">
    <AgentChatPrompt
      v-model="input"
      v-model:files="files"
      accept="text/plain"
      placeholder="Ask the Agent…"
      status="ready"
      @submit="submitted = $event.text"
    />
    <p v-if="submitted" class="text-xs text-muted">
      Submitted: {{ submitted }}
    </p>
  </div>
</template>
