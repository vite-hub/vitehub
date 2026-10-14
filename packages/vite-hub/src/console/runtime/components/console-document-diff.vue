<script setup lang="ts">
import { AgentMultiFileDiff } from "@vite-hub/ui";
import { computed } from "vue";

/** Shows two versions of one document as Markdown files with frontmatter. */
const props = defineProps<{
  after: { body: string, data: Record<string, unknown> } | null;
  before: { body: string, data: Record<string, unknown> } | null;
  name: string;
}>();

function render(version: { body: string, data: Record<string, unknown> } | null): string {
  if (!version) return "";
  const fields = Object.entries(version.data)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  // Compare bodies by content, not by a trailing newline that the rich editor drops.
  const body = version.body.endsWith("\n") ? version.body : `${version.body}\n`;
  return `${fields.length ? `---\n${fields.join("\n")}\n---\n\n` : ""}${body}`;
}

const oldFile = computed(() => ({ contents: render(props.before), name: props.name }));
const newFile = computed(() => ({ contents: render(props.after), name: props.name }));
const same = computed(() => oldFile.value.contents === newFile.value.contents);
</script>

<template>
  <p v-if="same" class="rounded-md border border-default px-3 py-2 text-xs text-muted">Both versions are the same.</p>
  <AgentMultiFileDiff
    v-else
    class="overflow-hidden rounded-md border border-default text-xs"
    :old-file="oldFile"
    :new-file="newFile"
    :options="{ diffStyle: 'unified', disableFileHeader: true, overflow: 'wrap' }"
  />
</template>
