<script setup lang="ts">
import { computed } from "vue";

import { consoleHintParts } from "../client/documents";

/** Text whose names in backticks, such as `console.origins`, render as code, the same way setup hints do. */
const props = defineProps<{ text: string }>();

const parts = computed(() => consoleHintParts(props.text));
</script>

<template>
  <!-- One line of markup, so no space falls between code and the punctuation after it. -->
  <template v-for="(part, index) in parts" :key="index"><code v-if="part.code" class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] text-highlighted">{{ part.text }}</code><template v-else>{{ part.text }}</template></template>
</template>
