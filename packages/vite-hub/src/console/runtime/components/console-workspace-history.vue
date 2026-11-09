<script setup lang="ts">
import { computed } from "vue";

import { consoleDateTime } from "../client/format";

type WorkspaceRevision = {
  id: string;
  ref: string;
  createdAt: string;
  message?: string;
  metadata?: Record<string, unknown>;
};
type WorkspaceHistoryRef = { name: string; head: WorkspaceRevision };

const props = defineProps<{
  refs: readonly WorkspaceHistoryRef[];
  revisions: readonly WorkspaceRevision[];
  selectedRef?: string;
  selectedRevision?: string;
  cursor?: string;
  loading?: boolean;
  error?: string;
}>();
const emit = defineEmits<{
  selectRef: [ref: string];
  selectRevision: [revision: string | undefined];
  loadMore: [];
}>();

const selected = computed(() => props.revisions.find(revision => revision.id === props.selectedRevision));
const selectedUrl = computed(() => {
  const url = selected.value?.metadata?.url;
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
});

function revisionLabel(revision: WorkspaceRevision): string {
  const subject = revision.message?.split("\n", 1)[0]?.trim();
  return subject ? `${revision.id.slice(0, 7)} · ${subject}` : revision.id.slice(0, 12);
}

function revisionDate(revision: WorkspaceRevision): string {
  return consoleDateTime(revision.createdAt);
}

// A select item cannot have an empty value, so the current files get their own key.
const currentFiles = "current-files";
const refItems = computed(() => props.refs.map(item => ({ label: item.name, value: item.name })));
const revisionItems = computed(() => [
  { label: "Current files", value: currentFiles },
  ...props.revisions.map(revision => ({ label: revisionLabel(revision), value: revision.id })),
]);
function selectRevision(value: unknown): void {
  emit("selectRevision", value === currentFiles || typeof value !== "string" ? undefined : value);
}
</script>

<template>
  <section v-if="props.refs.length" class="flex flex-wrap items-end gap-3" aria-label="Workspace history">
    <UFormField label="Ref">
      <USelect :model-value="props.selectedRef" :items="refItems" class="w-40" aria-label="Workspace history ref" @update:model-value="emit('selectRef', String($event))" />
    </UFormField>
    <UFormField label="Revision">
      <USelect :model-value="props.selectedRevision ?? currentFiles" :items="revisionItems" class="w-64" aria-label="Workspace history revision" @update:model-value="selectRevision" />
    </UFormField>
    <UButton v-if="selectedUrl" :to="selectedUrl" target="_blank" rel="noreferrer" variant="ghost" icon="i-lucide-github" label="GitHub" aria-label="Open revision on GitHub" />
    <small v-if="selected" class="text-xs text-dimmed" :title="selected.createdAt">{{ revisionDate(selected) }}</small>
    <UButton v-if="props.cursor" variant="outline" :loading="props.loading" :label="props.loading ? 'Loading…' : 'Load older'" @click="emit('loadMore')" />
    <p v-if="props.error" role="alert" class="w-full text-sm text-error">{{ props.error }}</p>
  </section>
</template>
