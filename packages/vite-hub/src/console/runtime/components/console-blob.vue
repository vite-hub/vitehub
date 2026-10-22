<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { createConsoleBlobMediaClient } from "../client/blob-media";
import { consoleFolderName, consoleFolderTrail } from "../client/media-library";
import { rememberConsoleSection } from "../sections";
import ConsoleBlobDetail from "./console-blob-detail.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMediaBrowser from "./console-media-browser.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";

import type { ConsoleMediaFile } from "../client/media-library";

/**
 * The Blob section: one Blob Store in the media browser of Content, read-only, with its raw metadata next to it. The
 * store, the folder, the open object, and "Show ViteHub files" live in the URL, so a link opens the same view.
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
const router = useRouter();
const stores = ref<string[]>([]);
const active = shallowRef<ConsoleMediaFile>();
const activeError = ref<string>();

function query(name: string): string {
  const value = route.query[name];
  return String(value) === value ? value : "";
}

function setQuery(next: Record<string, string | undefined>): void {
  void router.replace({ query: { ...route.query, ...next } });
}

const store = computed({
  get: () => query("store") || "default",
  set: (value: string) => setQuery({ file: undefined, folder: undefined, store: value === "default" ? undefined : value }),
});
const showVitehub = computed({
  get: () => query("vitehub") === "1",
  set: (value: boolean) => setQuery({ file: undefined, vitehub: value ? "1" : undefined }),
});
const folder = computed({
  get: () => query("folder"),
  set: (value: string) => setQuery({ file: undefined, folder: value || undefined }),
});

// A new client per store and per ViteHub file switch remounts the browser, so it lists from the start.
const client = computed(() => createConsoleBlobMediaClient(props.blobBase, {
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
watch([() => query("file"), client], async ([pathname]) => {
  activeError.value = undefined;
  if (!pathname) {
    active.value = undefined;
    return;
  }
  if (active.value?.pathname === pathname) return;
  try {
    active.value = await client.value.get(pathname);
  }
  catch (error) {
    active.value = undefined;
    activeError.value = error instanceof Error ? error.message : "The object could not be loaded.";
  }
}, { immediate: true });

function open(file: ConsoleMediaFile | undefined): void {
  active.value = file;
  setQuery({ file: file?.pathname });
}

onMounted(() => rememberConsoleSection("blob"));
</script>

<template>
  <ConsoleFrame active="blob" :sections-base="sectionsBase">
    <ConsoleSearch :agents-base="agentsBase" :definitions-base="definitionsBase" :kv-base="kvBase" :search-base="searchBase" :sections-base="sectionsBase" />

    <UDashboardPanel id="blob-objects" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <ConsolePageHeader :title="folder ? consoleFolderName(folder) : 'Blob'" :trail="trail" :back="trail.at(-1)" :description="stores.length > 1 ? undefined : store" :toggle="false">
        <template #right>
          <span class="text-xs text-dimmed">Read-only</span>
        </template>
      </ConsolePageHeader>
      <div class="relative flex min-h-0 flex-1">
        <ConsoleMediaBrowser
          :key="`${store}:${showVitehub}`"
          v-model:folder="folder"
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
          <p class="text-sm text-highlighted">Couldn't open {{ query("file") }}</p>
          <p class="text-xs text-muted">{{ activeError }}</p>
          <UButton variant="outline" size="sm" label="Close" @click="open(undefined)" />
        </div>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
