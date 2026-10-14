<script setup lang="ts">
import { computed, ref } from "vue";

import { consoleErrorMessage, consoleRevisionLabel as label, consoleRevisionTone as tone, groupConsoleRevisionRuns } from "../client/documents";
import { dayLabel } from "../client/time";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleStatus from "./console-status.vue";

import type { ConsoleDocumentRevision, ConsoleRevisionRun } from "../client/documents";

/**
 * The versions of one document, newest first, under day labels. Consecutive saves by one person show as one row, such
 * as `Saved · 12 edits`, since the editor saves after each pause in typing; the row expands to every save.
 */
const props = defineProps<{
  cursor?: string;
  error?: unknown;
  loadedAt: number;
  loading?: boolean;
  revisions: readonly ConsoleDocumentRevision[];
  /** The revision open in the comparison, highlighted in the list. */
  selected?: string;
}>();

const emit = defineEmits<{ more: [], open: [revision: ConsoleDocumentRevision] }>();

const expanded = ref(new Set<string>());

const days = computed(() => {
  const groups: Array<{ label: string, runs: ConsoleRevisionRun[] }> = [];
  for (const run of groupConsoleRevisionRuns(props.revisions)) {
    const day = dayLabel(run.revisions[0]!.createdAt, props.loadedAt) ?? "Unknown date";
    const last = groups.at(-1);
    if (last?.label === day) last.runs.push(run);
    else groups.push({ label: day, runs: [run] });
  }
  return groups;
});

function key(revision: ConsoleDocumentRevision): string {
  return `${revision.ref}:${revision.id}`;
}

function toggle(run: ConsoleRevisionRun): void {
  const id = key(run.revisions[0]!);
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function initials(name: string): string {
  return name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join("") || "?";
}

</script>

<template>
  <div class="grid gap-4">
    <UAlert v-if="error" color="error" variant="subtle" title="Couldn't load history" :description="consoleErrorMessage(error)" />
    <div v-else-if="loading && !revisions.length" class="grid gap-1">
      <USkeleton v-for="index in 4" :key="index" class="h-10 rounded-md" />
    </div>
    <p v-else-if="!revisions.length" class="px-2 text-xs text-muted">No versions yet.</p>
    <template v-else>
      <section v-for="day in days" :key="day.label" :aria-label="day.label">
        <h3 class="px-2 pb-1 text-xs font-medium text-muted">{{ day.label }}</h3>
        <ol class="grid">
          <li v-for="run in day.runs" :key="key(run.revisions[0]!)">
            <div class="group flex items-center rounded-md" :class="selected === run.revisions[0]!.id ? 'bg-elevated' : 'hover:bg-elevated/60'">
              <button
                type="button"
                class="grid min-h-10 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1.5 text-left focus-visible:outline-2"
                @click="emit('open', run.revisions[0]!)"
              >
                <span class="grid min-w-0 gap-0.5">
                  <span class="flex min-w-0 items-center gap-1.5">
                    <ConsoleStatus :label="label(run.revisions[0]!)" :tone="tone(run.revisions[0]!)" class="text-[13px] text-highlighted" />
                    <span v-if="run.revisions.length > 1" class="shrink-0 text-xs text-muted tabular-nums">· {{ run.revisions.length }} edits</span>
                  </span>
                  <span v-if="run.revisions[0]!.author" class="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                    <UAvatar :text="initials(run.revisions[0]!.author)" :alt="run.revisions[0]!.author" size="3xs" class="shrink-0" />
                    <span class="truncate">{{ run.revisions[0]!.author }}</span>
                  </span>
                </span>
                <span class="text-xs text-muted"><ConsoleRelativeTime :value="run.revisions[0]!.createdAt" /></span>
              </button>
              <UButton
                v-if="run.revisions.length > 1"
                variant="ghost"
                size="xs"
                class="me-1"
                :icon="expanded.has(key(run.revisions[0]!)) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                :aria-label="expanded.has(key(run.revisions[0]!)) ? 'Hide each save' : `Show each of ${run.revisions.length} saves`"
                :aria-expanded="expanded.has(key(run.revisions[0]!))"
                @click="toggle(run)"
              />
            </div>
            <ol v-if="expanded.has(key(run.revisions[0]!))" class="ms-4 grid border-s border-default ps-2">
              <li v-for="revision in run.revisions" :key="key(revision)">
                <button
                  type="button"
                  class="flex h-8 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-xs text-muted hover:bg-elevated/60 focus-visible:outline-2"
                  :class="selected === revision.id ? 'bg-elevated text-highlighted' : ''"
                  @click="emit('open', revision)"
                >
                  <span class="font-mono">{{ revision.id.slice(0, 7) }}</span>
                  <ConsoleRelativeTime :value="revision.createdAt" />
                </button>
              </li>
            </ol>
          </li>
        </ol>
      </section>
    </template>
    <UButton v-if="cursor" class="justify-self-start" variant="outline" size="xs" label="Older versions" :loading="loading" @click="emit('more')" />
  </div>
</template>
