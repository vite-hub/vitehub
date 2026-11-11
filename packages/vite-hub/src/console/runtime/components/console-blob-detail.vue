<script setup lang="ts">
import { CopyButton } from "@vite-hub/ui";
import { computed } from "vue";

import { consoleBytes } from "../client/format";
import { consoleMediaFormat, consoleMediaType, consoleMediaTypeIcons } from "../client/media-library";
import ConsolePropertyList from "./console-property-list.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";

import type { ConsoleBlobObject } from "../client/blob-media";
import type { ConsoleMediaFile } from "../client/media-library";
import ConsoleStatGrid from "./console-stat-grid.vue";

/**
 * The raw metadata of one Blob object, next to the Blob browser: what the store recorded, HTTP metadata, and custom
 * metadata. A double click in the list opens the contents.
 */
const props = defineProps<{
  file: ConsoleMediaFile;
  /** The raw object, once a listing returned it. */
  object?: ConsoleBlobObject;
  store: string;
}>();

const emit = defineEmits<{ close: []; open: [] }>();

const type = computed(() => consoleMediaType(props.file.contentType));
const facts = computed(() => [
  { label: "Format", value: consoleMediaFormat(props.file) },
  { label: "Size", value: consoleBytes(props.file.size) },
  { label: "Store", value: props.store },
]);
const recorded = computed(() => [
  { label: "Content type", mono: Boolean(props.object?.contentType), value: props.object?.contentType ?? "Not recorded" },
  { label: "ETag", mono: Boolean(props.object?.httpEtag), value: props.object?.httpEtag ?? "Not recorded" },
  { label: "Provider URL", value: props.object?.urlAvailable ? "Available" : "Not available" },
]);
// The full pathname wraps after a slash, so a folder or file name stays on one line.
const pathSegments = computed(() => props.file.pathname.split(/(?<=\/)/));
const sorted = (entries: Record<string, string> | undefined) =>
  Object.entries(entries ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([label, value]) => ({ label, mono: true, value }));
const httpMetadata = computed(() => sorted(props.object?.httpMetadata));
const customMetadata = computed(() => sorted(props.object?.customMetadata));
</script>

<template>
  <aside class="flex min-h-0 flex-col bg-default" :aria-label="`Details of ${file.name}`">
    <header class="flex h-(--ui-header-height) shrink-0 items-center gap-2 border-b border-default px-4">
      <UIcon :name="consoleMediaTypeIcons[type]" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
      <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted" :title="file.pathname">{{ file.name }}</h2>
      <!-- The list opens a file with a double click. This button is the keyboard and touch way to do the same. -->
      <UTooltip text="Open in a new tab">
        <UButton variant="ghost" size="sm" icon="i-lucide-arrow-up-right" :aria-label="`Open ${file.name} in a new tab`" @click="emit('open')" />
      </UTooltip>
      <UTooltip text="Close" :kbds="['esc']">
        <UButton variant="ghost" icon="i-lucide-x" aria-label="Close details" @click="emit('close')" />
      </UTooltip>
    </header>
    <div class="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto p-4" @keydown.esc="emit('close')">
      <section class="grid gap-3" aria-label="File information">
        <ConsoleStatGrid :items="facts" :columns="3" />
        <div class="grid gap-0.5">
          <span class="text-xs text-dimmed">Uploaded</span>
          <span class="text-[13px] text-highlighted"><ConsoleRelativeTime :value="file.createdAt" /></span>
        </div>
        <div class="grid gap-1">
          <span class="text-xs text-dimmed">Pathname</span>
          <div class="flex min-w-0 items-start gap-1 rounded-md bg-elevated/60 py-1 ps-2 pe-1">
            <code class="min-w-0 flex-1 py-0.5 text-xs leading-5">
              <span v-for="(segment, index) in pathSegments" :key="index" class="inline-block max-w-full [overflow-wrap:anywhere]">{{ segment }}</span>
            </code>
            <CopyButton :value="file.pathname" size="xs" aria-label="Copy pathname" />
          </div>
        </div>
      </section>
      <ConsolePropertyList title="Recorded by the store" :items="recorded" />
      <ConsolePropertyList title="HTTP metadata" count :items="httpMetadata" empty="No HTTP metadata" empty-description="The store returned none for this object." />
      <ConsolePropertyList title="Custom metadata" count :items="customMetadata" empty="No custom metadata" empty-description="Metadata that the app sets on upload shows here." />
      <p class="text-xs text-muted">Open, or double-click the file in the list, to see its contents in a new tab.</p>
    </div>
  </aside>
</template>
