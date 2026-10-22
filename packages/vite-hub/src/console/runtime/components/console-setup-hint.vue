<script setup lang="ts">
import { computed } from "vue";

import { consoleHintParts } from "../client/documents";

import type { ConsoleDocumentHint } from "../definitions";

/**
 * A fix that the owner names for a feature the project lacks, such as "Add `authorize` to `defineContent()`": the
 * sentence with its code set as code, then a link to the docs.
 */
const props = defineProps<{ hint: ConsoleDocumentHint }>();

const parts = computed(() => consoleHintParts(props.hint.message));
</script>

<template>
  <!-- One line of markup, so no space falls between code and the punctuation after it. -->
  <span><template v-for="(part, index) in parts" :key="index"><code v-if="part.code" class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] text-highlighted">{{ part.text }}</code><template v-else>{{ part.text }}</template></template><template v-if="hint.docs">{{ " " }}<a :href="hint.docs" target="_blank" rel="noreferrer" class="whitespace-nowrap text-highlighted underline decoration-(--ui-border-accented) underline-offset-2 hover:decoration-(--ui-text-muted)">Read the docs</a></template></span>
</template>
