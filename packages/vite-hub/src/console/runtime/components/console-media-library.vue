<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";

import { consoleErrorMessage } from "../client/documents";
import { consoleFolderName, consoleFolderTrail, consoleMediaTypes, rememberConsoleMediaFolder } from "../client/media-library";
import { queryChoice, querySelection, queryText, useConsoleQuery } from "../client/route-query";
import ConsoleMediaBrowser from "./console-media-browser.vue";
import ConsoleMediaDetail from "./console-media-detail.vue";
import ConsolePageHeader from "./console-page-header.vue";

import type { ConsoleMediaAccess, ConsoleMediaClient, ConsoleMediaFile } from "../client/media-library";

/**
 * The Media page of a document editor section: the files of the served Blob Store with folders, uploads, bulk moves and
 * deletes, and a detail panel for alt text, the focal point, and crops. The folder, the open file, the search, and the
 * type filter live in the URL, so a link opens the same view.
 */
const props = defineProps<{
  client: ConsoleMediaClient;
  label: string;
  section: string;
}>();

const browser = ref<InstanceType<typeof ConsoleMediaBrowser>>();
const access = ref<ConsoleMediaAccess>({ manage: false, read: true, write: false });
const served = ref<string | null>(null);
const selected = ref<string[]>([]);
const active = shallowRef<ConsoleMediaFile>();
const activeError = ref<unknown>();

const state = useConsoleQuery({
  file: querySelection(),
  folder: queryText({ history: "push" }),
  q: queryText(),
  type: queryChoice(["all", ...consoleMediaTypes], "all"),
});
const { file, q: search, type } = state;
const folder = computed({
  get: () => state.folder.value,
  set: (value: string) => {
    state.folder.value = value;
    file.value = undefined;
  },
});

watch(folder, value => rememberConsoleMediaFolder(props.section, value), { immediate: true });

// The folders above the open one, as links: Media, then each parent folder.
const trail = computed(() => consoleFolderTrail(folder.value).slice(0, -1).map(path => ({
  label: path ? consoleFolderName(path) : props.label,
  to: { query: path ? { folder: path } : {} },
})));
const actions = ref<HTMLElement | null>(null);

// `?file=` opens the details of one file, also after a reload.
watch(file, async (pathname) => {
  if (!pathname) {
    active.value = undefined;
    return;
  }
  if (active.value?.pathname === pathname) return;
  try {
    active.value = await props.client.get(pathname);
    activeError.value = undefined;
  }
  catch (error) {
    active.value = undefined;
    activeError.value = error;
  }
}, { immediate: true });

function open(next: ConsoleMediaFile | undefined): void {
  active.value = next;
  file.value = next?.pathname;
}

function updated(file: ConsoleMediaFile): void {
  active.value = file;
  browser.value?.replace(file);
}
</script>

<template>
  <ConsolePageHeader :title="folder ? consoleFolderName(folder) : label" :trail="trail" :back="trail.at(-1)">
    <template #right>
      <span v-if="!access.write" class="text-xs text-dimmed">Read-only</span>
      <UTooltip v-else-if="!access.manage" text="Moving and deleting files needs publish access">
        <span class="hidden text-xs text-dimmed sm:inline">Can't move or delete</span>
      </UTooltip>
      <div ref="actions" class="flex items-center gap-1.5" />
    </template>
  </ConsolePageHeader>
  <div class="relative flex min-h-0 flex-1">
    <ConsoleMediaBrowser
      ref="browser"
      v-model:folder="folder"
      v-model:selected="selected"
      v-model:search="search"
      v-model:type="type"
      mode="page"
      :root-label="label"
      :actions-target="actions"
      :client="client"
      :active="active?.pathname"
      @open="open"
      @info="(info) => { access = info.access; served = info.served }"
    />
    <ConsoleMediaDetail
      v-if="active"
      :key="active.pathname"
      class="vitehub-media-library__detail"
      :access="access"
      :client="client"
      :file="active"
      :section="section"
      :served="served"
      @close="open(undefined)"
      @updated="updated"
      @rename="(file) => browser?.askMove([file])"
      @remove="(file) => browser?.askRemove([file])"
    />
    <div v-else-if="activeError" class="vitehub-media-library__detail flex flex-col items-center justify-center gap-2 p-6 text-center">
      <p class="text-sm text-highlighted">Couldn't open {{ file }}</p>
      <p class="text-xs text-muted">{{ consoleErrorMessage(activeError) }}</p>
      <UButton variant="outline" size="sm" label="Close" @click="open(undefined)" />
    </div>
  </div>
</template>
