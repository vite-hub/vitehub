<script setup lang="ts">
import { AgentMultiFileDiff } from "@vite-hub/ui";
import { computed } from "vue";

import { consoleDocumentText } from "../client/documents";

import type { ConsoleDocumentFormat } from "../client/documents";

/** A stored file as written, or unsaved editor values that the diff renders as one. */
type Version = string | { body: string, data: Record<string, unknown> } | null;

/** Shows two versions of one document as files in its format: Markdown with frontmatter, JSON, or YAML. */
const props = defineProps<{
  after: Version;
  before: Version;
  /** Defaults to Markdown. */
  format?: ConsoleDocumentFormat;
  name: string;
}>();

function render(version: Version): string {
  if (version === null) return "";
  if (!(version instanceof Object)) return version;
  // Both sides list fields in one order, so only changed values differ.
  const data = Object.fromEntries(Object.entries(version.data).sort(([left], [right]) => left.localeCompare(right)));
  return consoleDocumentText({ body: version.body, data }, props.format);
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
