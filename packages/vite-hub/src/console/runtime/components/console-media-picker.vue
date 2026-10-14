<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";

import { consoleErrorMessage } from "../client/documents";
import { consoleMediaAccepts, consoleFolderName, rememberedConsoleMediaFolder } from "../client/media-library";
import { useConsoleMediaUploads } from "../client/media-uploads";
import { useConsoleToast } from "../client/toast";
import ConsoleMediaBrowser from "./console-media-browser.vue";

import type { ConsoleMediaItem, ConsoleMediaRequest } from "../client/media";
import type { ConsoleMediaAccess, ConsoleMediaClient, ConsoleMediaFile } from "../client/media-library";

/**
 * The media picker of a document editor section. **Image…** in the body and Blob reference fields open the library in a
 * dialog to browse, upload, and pick. Files pasted or dropped into the body upload at once to the folder last opened in
 * the library, without a dialog. Picked files keep their Blob pathname, so documents stay portable across hosts.
 */
const props = defineProps<{
  client: ConsoleMediaClient;
  section: string;
}>();

const toast = useConsoleToast();
const open = ref(false);
const request = shallowRef<ConsoleMediaRequest>();
const folder = ref("");
const selected = ref<string[]>([]);
const browser = ref<InstanceType<typeof ConsoleMediaBrowser>>();
const access = ref<ConsoleMediaAccess>({ manage: false, read: true, write: false });
const alt = ref("");
const inserting = ref(false);
let settle: ((items: ConsoleMediaItem[]) => void) | undefined;

const single = computed(() => !request.value?.multiple);
const accept = computed(() => request.value?.accept ?? (request.value?.kind === "image" ? ["image/*"] : undefined));
const title = computed(() => (request.value?.kind === "file" ? "Choose a file" : single.value ? "Choose an image" : "Insert images"));
const picked = computed<ConsoleMediaFile[]>(() => selected.value.flatMap(pathname => browser.value?.file(pathname) ?? []));
/** The alt input changed since the selection, so Choose saves it to the file. */
const altEdited = ref(false);
const one = computed(() => (picked.value.length === 1 ? picked.value[0] : undefined));

function item(file: ConsoleMediaFile, altText = file.alt): ConsoleMediaItem {
  const result: ConsoleMediaItem = { reference: { contentType: file.contentType, pathname: file.pathname, size: file.size }, src: file.pathname };
  if (altText) result.alt = altText;
  return result;
}

function finish(items: ConsoleMediaItem[]): void {
  settle?.(items);
  settle = undefined;
  open.value = false;
}

async function insert(): Promise<void> {
  const files = picked.value;
  if (!files.length) return;
  const file = one.value;
  const text = alt.value.trim();
  // Alt text typed here belongs to the file, so every document that uses it gets it.
  if (file && altEdited.value && text !== (file.alt ?? "") && access.value.write) {
    inserting.value = true;
    try {
      await props.client.update(file.pathname, { alt: text || null });
    }
    catch (error) {
      toast.error(`Couldn't save the alt text. ${consoleErrorMessage(error, "Try again.")}`);
    }
    finally {
      inserting.value = false;
    }
  }
  finish(files.map(entry => item(entry, entry === file && altEdited.value ? text || undefined : entry.alt)));
}

// Pasted and dropped files upload without a dialog.
const uploads = useConsoleMediaUploads(() => props.client);

async function uploadNow(next: ConsoleMediaRequest): Promise<ConsoleMediaItem[]> {
  const files = next.files.filter(file => consoleMediaAccepts(next.accept ?? (next.kind === "image" ? ["image/*"] : undefined), file.type));
  if (!files.length) return [];
  const target = rememberedConsoleMediaFolder(props.section);
  const label = files.length === 1 ? files[0]!.name : `${files.length} files`;
  const pending = toast.show({ duration: 60_000, title: `Uploading ${label}…` });
  const results = await uploads.add(files, target);
  toast.remove(pending.id);
  const failed = uploads.entries.value.filter(entry => entry.state === "failed");
  if (failed.length) toast.error(`Couldn't upload ${failed.length === 1 ? failed[0]!.file.name : `${failed.length} files`}. ${failed[0]!.error ?? ""}`.trim());
  uploads.clear();
  if (results.length) toast.show({ title: `${results.length === 1 ? results[0]!.file.name : `${results.length} files`} uploaded to ${consoleFolderName(target)}` });
  return results.map(result => item(result.file));
}

/** Asks for media. Resolves to an empty list when the person cancels. */
function pick(next: ConsoleMediaRequest): Promise<ConsoleMediaItem[]> {
  if (next.files.length) return uploadNow(next);
  settle?.([]);
  request.value = next;
  folder.value = rememberedConsoleMediaFolder(props.section);
  selected.value = [];
  alt.value = "";
  altEdited.value = false;
  open.value = true;
  return new Promise(resolve => (settle = resolve));
}

function select(paths: string[]): void {
  selected.value = paths;
  const file = paths.length === 1 ? browser.value?.file(paths[0]!) : undefined;
  alt.value = file?.alt ?? "";
  altEdited.value = false;
}

defineExpose({ pick });
</script>

<template>
  <UModal
    :open="open"
    :title="title"
    :description="request?.kind === 'file' ? 'Pick a file from the library, or upload one.' : 'Pick from the library, or drop images here to upload them.'"
    :ui="{ content: 'sm:max-w-5xl h-[min(44rem,calc(100dvh-4rem))] flex flex-col', body: 'flex min-h-0 flex-1 flex-col p-0 sm:p-0' }"
    @update:open="(value) => { if (!value) finish([]) }"
  >
    <template #body>
      <ConsoleMediaBrowser
        ref="browser"
        v-model:folder="folder"
        mode="picker"
        root-label="Media"
        :selected="selected"
        :client="client"
        :accept="accept"
        :multiple="!single"
        @update:selected="select"
        @confirm="insert"
        @info="(info) => { access = info.access }"
      />
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap items-center gap-3">
        <template v-if="one && one.contentType.startsWith('image/')">
          <UInput
            v-model="alt"
            class="min-w-0 flex-1"
            size="sm"
            :disabled="!access.write && Boolean(one.alt)"
            :placeholder="`Alt text for ${one.name}`"
            aria-label="Alt text"
            @update:model-value="altEdited = true"
          />
        </template>
        <p v-else class="min-w-0 flex-1 truncate text-[13px] text-muted">
          {{ picked.length ? `${picked.length} selected` : single ? "Nothing selected" : "Select images, or Shift-click a range" }}
        </p>
        <div class="flex shrink-0 gap-2">
          <UButton variant="ghost" label="Cancel" @click="finish([])" />
          <UButton :label="request?.kind === 'file' || single ? 'Choose' : 'Insert'" :disabled="!picked.length" :loading="inserting" @click="insert" />
        </div>
      </div>
    </template>
  </UModal>
</template>
