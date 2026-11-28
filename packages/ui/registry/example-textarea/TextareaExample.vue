<script setup lang="ts">
import { Textarea } from "../textarea/index.ts";
import { ref } from "vue";

const notes = ref("");
</script>

<template>
  <div data-slot="example-textarea" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Textarea v-model="notes" aria-label="Notes" placeholder="What changed?" />
    <Textarea aria-label="Reason" invalid />
  </div>
</template>
