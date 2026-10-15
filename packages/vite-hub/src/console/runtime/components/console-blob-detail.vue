<script setup lang="ts">
import { computed } from "vue";

import { consoleBytes } from "../client/format";
import { consoleMediaFormat, consoleMediaType, consoleMediaTypeIcons } from "../client/media-library";
import { useConsoleToast } from "../client/toast";
import ConsolePropertyList from "./console-property-list.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";

import type { ConsoleBlobObject } from "../client/blob-media";
import type { ConsoleMediaFile } from "../client/media-library";

/**
 * The raw metadata of one Blob object, next to the Blob browser: what the store recorded, HTTP metadata, and custom
 * metadata. The Console does not download object contents.
 */
const props = defineProps<{
  file: ConsoleMediaFile;
  /** The raw object, once a listing returned it. */
  object?: ConsoleBlobObject;
  store: string;
}>();

const emit = defineEmits<{ close: [] }>();

const toast = useConsoleToast();
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
const sorted = (entries: Record<string, string> | undefined) =>
  Object.entries(entries ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([label, value]) => ({ label, mono: true, value }));
const httpMetadata = computed(() => sorted(props.object?.httpMetadata));
const customMetadata = computed(() => sorted(props.object?.customMetadata));

async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.show({ title: "Pathname copied" });
  }
  catch {
    toast.error("Couldn't copy the pathname. Select it and copy it instead.");
  }
}
</script>

<template>
  <aside class="flex min-h-0 flex-col bg-default" :aria-label="`Details of ${file.name}`">
    <header class="flex h-(--ui-header-height) shrink-0 items-center gap-2 border-b border-default px-4">
      <UIcon :name="consoleMediaTypeIcons[type]" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
      <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted" :title="file.pathname">{{ file.name }}</h2>
      <UTooltip text="Close" :kbds="['esc']">
        <UButton variant="ghost" size="sm" icon="i-lucide-x" aria-label="Close details" @click="emit('close')" />
      </UTooltip>
    </header>
    <div class="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto p-4" @keydown.esc="emit('close')">
      <section class="grid gap-3" aria-label="File information">
        <dl class="grid grid-cols-3 gap-x-4 gap-y-2">
          <div v-for="fact in facts" :key="fact.label" class="grid min-w-0 gap-0.5">
            <dt class="text-xs text-dimmed">{{ fact.label }}</dt>
            <dd class="truncate text-[13px] text-highlighted tabular-nums">{{ fact.value }}</dd>
          </div>
        </dl>
        <div class="grid gap-0.5">
          <span class="text-xs text-dimmed">Uploaded</span>
          <span class="text-[13px] text-highlighted"><ConsoleRelativeTime :value="file.createdAt" /></span>
        </div>
        <div class="grid gap-1">
          <span class="text-xs text-dimmed">Pathname</span>
          <div class="flex min-w-0 items-center gap-1 rounded-md bg-elevated/60 py-1 ps-2 pe-1">
            <code class="min-w-0 flex-1 truncate text-xs" :title="file.pathname">{{ file.pathname }}</code>
            <UButton variant="ghost" size="xs" icon="i-lucide-copy" aria-label="Copy pathname" @click="copy(file.pathname)" />
          </div>
        </div>
      </section>
      <ConsolePropertyList title="Recorded by the store" :items="recorded" />
      <ConsolePropertyList title="HTTP metadata" count :items="httpMetadata" empty="The store returned no HTTP metadata." />
      <ConsolePropertyList title="Custom metadata" count :items="customMetadata" empty="The store returned no custom metadata." />
      <p class="text-xs text-muted">Metadata only. The Console does not download object contents or change Blob Stores.</p>
    </div>
  </aside>
</template>
