<script setup lang="ts">
import type { ConsoleDocumentHint } from "../definitions";
import ConsoleCodeText from "./console-code-text.vue";

/**
 * A fix that the owner names for a feature the project lacks, such as "Add `authorize` to `defineContent()`": the
 * sentence with its code set as code, then a link to the docs.
 */
defineProps<{ hint: ConsoleDocumentHint }>();
</script>

<template>
  <!-- One line of markup, so no space falls between code and the punctuation after it. -->
  <span><ConsoleCodeText :text="hint.message" /><template v-if="hint.docs">{{ " " }}<a :href="hint.docs" target="_blank" rel="noreferrer" class="whitespace-nowrap text-highlighted underline decoration-(--ui-border-accented) underline-offset-2 hover:decoration-(--ui-text-muted)">Read the docs</a></template></span>
</template>
