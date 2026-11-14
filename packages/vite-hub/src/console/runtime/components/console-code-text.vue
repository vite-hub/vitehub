<script setup lang="ts">
import { computed } from "vue";

import { consoleHintParts } from "../client/documents";

/**
 * Text whose names in backticks, such as `console.origins`, render as inline code, the same way setup hints do. With
 * `code`, all of `text` is code. This is the one place that styles inline code in the Console.
 */
const props = defineProps<{ code?: boolean; text: string }>();

const parts = computed(() => (props.code ? [{ code: true, text: props.text }] : consoleHintParts(props.text)));
</script>

<template>
  <!-- One line of markup, so no space falls between code and the punctuation after it. -->
  <template v-for="(part, index) in parts" :key="index"><code v-if="part.code" class="rounded-md bg-elevated px-1 py-px font-mono text-[max(0.9em,0.75rem)] text-highlighted box-decoration-clone">{{ part.text }}</code><template v-else>{{ part.text }}</template></template>
</template>
