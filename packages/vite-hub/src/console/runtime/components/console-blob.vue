<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";

import { createConsoleBlobMediaClient } from "../client/blob-media";
import { isConsoleSectionReadOnly } from "../client/read-only";
import { consoleFolderName, consoleFolderTrail, consoleMediaTypes } from "../client/media-library";
import { queryChoice, queryFlag, querySelection, queryText, useConsoleQuery } from "../client/route-query";
import { rememberConsoleSection } from "../sections";
import ConsoleBlobDetail from "./console-blob-detail.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMediaBrowser from "./console-media-browser.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";

import type { ConsoleMediaFile } from "../client/media-library";

/**
 * The Blob section: one Blob Store in the media browser of Content, with its raw metadata next to it. Upload and delete run the `blob.put` and `blob.del` operations. The
 * store, the folder, the open object, the search, the type filter, and "Show ViteHub files" live in the URL, so a link opens the same view.
 */
const props = defineProps<{
  agentsBase: string;
  blobBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const route = useRoute();
const stores = ref<string[]>([]);
const active = shallowRef<ConsoleMediaFile>();
const activeError = ref<string>();

const state = useConsoleQuery({
  file: querySelection(),
  folder: queryText({ history: "push" }),
  q: queryText(),
  store: queryText({ fallback: "default", history: "push" }),
  type: queryChoice(["all", ...consoleMediaTypes], "all"),
  vitehub: queryFlag(),
});
const { file, q: search, type } = state;

const store = computed({
  get: () => state.store.value,
  set: (value: string) => {
    state.store.value = value;
    state.folder.value = "";
    file.value = undefined;
  },
});
const showVitehub = computed({
  get: () => state.vitehub.value,
  set: (value: boolean) => {
    state.vitehub.value = value;
    file.value = undefined;
  },
});
const folder = computed({
  get: () => state.folder.value,
  set: (value: string) => {
    state.folder.value = value;
    file.value = undefined;
  },
});

// Changes to the store, ViteHub file switch, or grant remount the browser, so it lists from the start.
const readOnly = ref(false);
// The client changes with the grant, so the browser remounts without upload and delete.
const client = computed(() => createConsoleBlobMediaClient(props.blobBase, {
  readOnly: readOnly.value,
  onPage: (page) => {
    stores.value = page.stores;
  },
  showVitehub: showVitehub.value,
  store: store.value,
}));
const storeItems = computed(() => (stores.value.length ? stores.value : [store.value]).map(name => ({ label: name, value: name })));
const trail = computed(() => consoleFolderTrail(folder.value).slice(0, -1).map(path => ({
  label: path ? consoleFolderName(path) : "Blob",
  to: { query: { ...route.query, file: undefined, folder: path || undefined } },
})));

// `?file=` opens the metadata of one object, also after a reload.
watch([file, client], async ([pathname, currentClient], [, previousClient]) => {
  activeError.value = undefined;
  if (!pathname) {
    active.value = undefined;
    return;
  }
  if (active.value?.pathname === pathname && currentClient === previousClient) return;
  try {
    active.value = await currentClient.get(pathname);
  }
  catch (error) {
    active.value = undefined;
    activeError.value = error instanceof Error ? error.message : "The object could not be loaded.";
  }
}, { immediate: true });

function open(next: ConsoleMediaFile | undefined): void {
  active.value = next;
  file.value = next?.pathname;
}

onMounted(async () => {
  rememberConsoleSection("blob");
  readOnly.value = await isConsoleSectionReadOnly(props.sectionsBase, "blob");
});
</script>

<template>
  <ConsoleFrame active="blob" :sections-base="sectionsBase">
    <ConsoleSearch :agents-base="agentsBase" :definitions-base="definitionsBase" :kv-base="kvBase" :search-base="searchBase" :sections-base="sectionsBase" />

    <UDashboardPanel id="blob-objects" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <ConsolePageHeader :title="folder ? consoleFolderName(folder) : 'Blob'" :trail="trail" :back="trail.at(-1)" :description="stores.length > 1 ? undefined : store" :toggle="false">
      </ConsolePageHeader>
      <div class="relative flex min-h-0 flex-1">
        <ConsoleMediaBrowser
          :key="`${store}:${showVitehub}:${readOnly}`"
          v-model:folder="folder"
          v-model:search="search"
          v-model:type="type"
          mode="page"
          root-label="Blob"
          default-view="list"
          view-key="vitehub:console:blob-view"
          search-placeholder="Filter by prefix…"
          empty-description="Objects show here when the application stores them."
          :client="client"
          :active="active?.pathname"
          @open="open"
        >
          <template #toolbar>
            <USelect v-if="stores.length > 1" v-model="store" class="w-36" size="sm" :items="storeItems" aria-label="Blob store" />
            <USwitch v-model="showVitehub" color="neutral" label="Show ViteHub files" size="xs" :ui="{ label: 'text-xs font-normal text-muted' }" />
          </template>
        </ConsoleMediaBrowser>
        <ConsoleBlobDetail
          v-if="active"
          :key="active.pathname"
          class="vitehub-media-library__detail"
          :file="active"
          :object="client.object(active.pathname)"
          :store="store"
          @close="open(undefined)"
        />
        <div v-else-if="activeError" class="vitehub-media-library__detail flex flex-col items-center justify-center gap-2 p-6 text-center">
          <p class="text-sm text-highlighted">Couldn't open {{ file }}</p>
          <p class="text-xs text-muted">{{ activeError }}</p>
          <UButton variant="outline" size="sm" label="Close" @click="open(undefined)" />
        </div>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
