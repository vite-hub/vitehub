<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

import type { ConsoleMediaItem, ConsoleMediaRequest } from "../client/media";

/**
 * The editor's own image picker, used when no media picker is provided. It inserts an image by Blob path or URL, since
 * uploading from the Console needs a media library. Pasted or dropped files are named so the person knows which path to
 * enter after uploading them elsewhere.
 */
const open = ref(false);
const request = ref<ConsoleMediaRequest>();
const src = ref("");
const alt = ref("");
const srcInput = ref<{ inputRef?: HTMLInputElement }>();
let settle: ((items: ConsoleMediaItem[]) => void) | undefined;

const files = computed(() => request.value?.files.map(file => file.name) ?? []);

function finish(items: ConsoleMediaItem[]): void {
  settle?.(items);
  settle = undefined;
  open.value = false;
}

function insert(): void {
  const value = src.value.trim();
  if (!value) return;
  finish([alt.value.trim() ? { alt: alt.value.trim(), src: value } : { src: value }]);
}

/** Asks for one image. Resolves to an empty list when the person cancels. */
function pick(next: ConsoleMediaRequest): Promise<ConsoleMediaItem[]> {
  settle?.([]);
  request.value = next;
  src.value = "";
  alt.value = next.files[0]?.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ") ?? "";
  open.value = true;
  void nextTick(() => srcInput.value?.inputRef?.focus());
  return new Promise(resolve => (settle = resolve));
}

defineExpose({ pick });
</script>

<template>
  <UModal
    :open="open"
    title="Insert image"
    description="Enter the Blob path or URL of the image. The Markdown stores it as written."
    :ui="{ content: 'sm:max-w-[540px]' }"
    @update:open="(value) => { if (!value) finish([]) }"
  >
    <template #body>
      <form id="vitehub-media-dialog" class="grid gap-4" @submit.prevent="insert">
        <p v-if="files.length" class="rounded-md bg-elevated/60 px-3 py-2 text-xs text-muted">
          The Console can't upload {{ files.join(", ") }} yet. Upload it to a Blob store, then enter its path.
        </p>
        <UFormField label="Blob path or URL" required :ui="{ label: 'text-xs' }">
          <UInput ref="srcInput" v-model="src" class="w-full" :ui="{ base: 'font-mono text-[13px]' }" placeholder="media/launch-cover.png" autocomplete="off" />
        </UFormField>
        <UFormField label="Alt text" description="Describes the image for people who can't see it." :ui="{ label: 'text-xs', description: 'text-xs' }">
          <UInput v-model="alt" class="w-full" placeholder="The Console editor with the slash menu open" autocomplete="off" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" label="Cancel" @click="finish([])" />
        <UButton type="submit" form="vitehub-media-dialog" label="Insert" :disabled="!src.trim()" />
      </div>
    </template>
  </UModal>
</template>
