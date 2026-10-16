<script setup lang="ts">
import { AgentMultiFileDiff } from "@vite-hub/ui";
import { computed } from "vue";

import { renderConsoleFrontmatter } from "../client/documents";

/** A stored file as written, or unsaved editor values that the diff renders as one. */
type Version = string | { body: string, data: Record<string, unknown> } | null;

/** Shows two versions of one document as Markdown files with frontmatter. */
const props = defineProps<{
  after: Version;
  before: Version;
  name: string;
}>();

function render(version: Version): string {
  if (version === null) return "";
  if (!(version instanceof Object)) return version;
  const fields = renderConsoleFrontmatter(version.data);
  // Compare bodies by content, not by a trailing newline that the rich editor drops.
  const body = version.body.endsWith("\n") ? version.body : `${version.body}\n`;
  return `${fields ? `---\n${fields}\n---\n\n` : ""}${body}`;
}

const oldFile = computed(() => ({ contents: render(props.before), name: props.name }));
const newFile = computed(() => ({ contents: render(props.after), name: props.name }));
const same = computed(() => oldFile.value.contents === newFile.value.contents);
</script>

<template>
  <p v-if="same" class="rounded-md border border-default px-3 py-2 text-xs text-muted">Both versions are the same.</p>
  <AgentMultiFileDiff
    v-else
    class="overflow-hidden rounded-md border border-default text-xs tabular-nums"
    :old-file="oldFile"
    :new-file="newFile"
    :options="{ diffStyle: 'unified', disableFileHeader: true, overflow: 'wrap' }"
  />
</template>
