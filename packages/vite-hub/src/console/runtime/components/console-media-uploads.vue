<script setup lang="ts">
import { computed } from "vue";

import { consoleBytes } from "../client/format";

import type { ConsoleMediaUploads } from "../client/media-uploads";

/**
 * The upload queue: one row per file with its progress, then a check, a duplicate note, or the reason it failed with a
 * retry. It sits in the corner of the library and folds away once everything is done and dismissed.
 */
const props = defineProps<{ uploads: ConsoleMediaUploads }>();

const entries = computed(() => props.uploads.entries.value);
const done = computed(() => entries.value.filter(entry => entry.state === "done").length);
const failed = computed(() => entries.value.filter(entry => entry.state === "failed").length);
const title = computed(() => {
  const pending = props.uploads.pending.value;
  if (pending) return `Uploading ${pending} ${pending === 1 ? "file" : "files"}`;
  if (failed.value) return `${failed.value} ${failed.value === 1 ? "upload" : "uploads"} failed`;
  return `${done.value} ${done.value === 1 ? "file" : "files"} uploaded`;
});
</script>

<template>
  <section v-if="entries.length" class="vitehub-media-uploads" aria-label="Uploads">
    <header class="flex h-10 items-center gap-2 border-b border-default ps-3 pe-1.5">
      <p class="min-w-0 flex-1 truncate text-[13px] font-medium text-highlighted" aria-live="polite">{{ title }}</p>
      <UButton v-if="!uploads.pending.value" variant="ghost" size="xs" icon="i-lucide-x" aria-label="Close uploads" @click="uploads.clear()" />
    </header>
    <ul class="max-h-64 overflow-y-auto py-1">
      <li v-for="entry in entries" :key="entry.id" class="grid gap-1 px-3 py-1.5">
        <div class="flex min-w-0 items-center gap-2">
          <UIcon
            :name="entry.state === 'done' ? 'i-lucide-check' : entry.state === 'failed' ? 'i-lucide-circle-alert' : 'i-lucide-loader-circle'"
            class="size-3.5 shrink-0"
            :class="entry.state === 'failed' ? 'text-error' : entry.state === 'done' ? 'text-muted' : 'animate-spin text-dimmed'"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate text-xs text-highlighted" :title="entry.file.name">{{ entry.file.name }}</span>
          <span v-if="entry.state === 'uploading' || entry.state === 'queued'" class="shrink-0 text-xs text-dimmed tabular-nums">
            {{ entry.state === "queued" ? "Waiting" : entry.progress >= 1 ? "Processing…" : `${Math.round(entry.progress * 100)}%` }}
          </span>
          <span v-else-if="entry.state === 'done'" class="shrink-0 text-xs text-dimmed tabular-nums">{{ consoleBytes(entry.file.size) }}</span>
          <template v-else>
            <UButton variant="ghost" size="xs" label="Retry" @click="uploads.retry(entry.id)" />
            <UButton variant="ghost" size="xs" icon="i-lucide-x" :aria-label="`Dismiss ${entry.file.name}`" @click="uploads.dismiss(entry.id)" />
          </template>
        </div>
        <div v-if="entry.state === 'uploading' || entry.state === 'queued'" class="h-0.5 overflow-hidden rounded-full bg-accented" aria-hidden="true">
          <div class="h-full bg-inverted transition-[width] duration-150 ease-out" :style="{ width: `${Math.round(entry.progress * 100)}%` }" />
        </div>
        <p v-if="entry.state === 'failed'" class="ps-5.5 text-xs text-error">{{ entry.error }}</p>
        <p v-else-if="entry.result?.duplicate" class="ps-5.5 text-xs text-muted">Already in the library as <span class="font-mono">{{ entry.result.file.pathname }}</span></p>
      </li>
    </ul>
  </section>
</template>

<style>
.vitehub-media-uploads {
  background: var(--ui-bg);
  border-radius: 0.75rem;
  bottom: 1rem;
  box-shadow: 0 0 0 1px var(--ui-border), 0 1px 1px rgb(0 0 0 / 2%), 0 4px 8px -4px rgb(0 0 0 / 4%), 0 16px 24px -8px rgb(0 0 0 / 8%);
  overflow: hidden;
  position: absolute;
  right: 1rem;
  width: min(20rem, calc(100% - 2rem));
  z-index: 20;
}
</style>
