<script setup lang="ts">
import { computed } from "vue";

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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Revision metadata crosses the Console JSON boundary.
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
  const date = new Date(revision.createdAt);
  return Number.isNaN(date.valueOf()) ? revision.createdAt : date.toLocaleString();
}
</script>

<template>
  <section v-if="props.refs.length" class="session-inspector__history" aria-label="Workspace history">
    <label>
      <span>Ref</span>
      <select :value="props.selectedRef" aria-label="Workspace history ref" @change="emit('selectRef', ($event.target as HTMLSelectElement).value)">
        <option v-for="item in props.refs" :key="item.name" :value="item.name">{{ item.name }}</option>
      </select>
    </label>
    <label>
      <span>Revision</span>
      <select :value="props.selectedRevision ?? ''" aria-label="Workspace history revision" @change="emit('selectRevision', (($event.target as HTMLSelectElement).value || undefined))">
        <option value="">Current files</option>
        <option v-for="revision in props.revisions" :key="revision.id" :value="revision.id">{{ revisionLabel(revision) }}</option>
      </select>
    </label>
    <a v-if="selectedUrl" :href="selectedUrl" target="_blank" rel="noreferrer" aria-label="Open revision on GitHub">
      <UIcon name="i-lucide-github" aria-hidden="true" />
      GitHub
    </a>
    <small v-if="selected" :title="selected.createdAt">{{ revisionDate(selected) }}</small>
    <button v-if="props.cursor" type="button" :disabled="props.loading" @click="emit('loadMore')">
      {{ props.loading ? "Loading…" : "Load older" }}
    </button>
    <p v-if="props.error" role="alert">{{ props.error }}</p>
  </section>
</template>
