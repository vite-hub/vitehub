<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";

import * as v from "valibot";
import { createConsoleBlobMediaClient } from "../client/blob-media";
import { requestConsole } from "../client/request";
import { useConsoleToast } from "../client/toast";
import { isConsoleSectionReadOnly } from "../client/read-only";
import { consoleFolderName, consoleFolderTrail, consoleMediaTypes } from "../client/media-library";
import { queryChoice, queryFlag, querySelection, queryText, useConsoleQuery } from "../client/route-query";
import { rememberConsoleSection } from "../sections";
import ConsoleBlobDetail from "./console-blob-detail.vue";
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

const toast = useConsoleToast();
const blobFileSchema = v.object({ contentType: v.optional(v.string()), data: v.string() });
// Types that a browser shows without running them. Any other file opens as plain text, so an HTML or SVG object
// cannot run script with the Console's origin.
const viewableTypes = /^(?:image\/(?:avif|gif|jpeg|png|webp)|application\/(?:json|pdf)|text\/(?:csv|markdown|plain))(?:;|$)/i;

/** Opens the contents of a file in a new tab, through `blob.get` or the URL that serves it. */
async function openContents(target: ConsoleMediaFile): Promise<void> {
  if (target.url) {
    window.open(target.url, "_blank", "noopener");
    return;
  }
  // The tab opens during the double click, so the browser does not block it while the file loads.
  const tab = window.open("about:blank", "_blank");
  if (!tab) {
    toast.error("The browser blocked the new tab. Allow pop-ups for this site to open files.");
    return;
  }
  tab.opener = null;
  try {
    const result = v.parse(blobFileSchema, await requestConsole(props.blobBase, {
      body: { action: "get", pathname: target.pathname, store: store.value },
      method: "POST",
    }));
    const type = result.contentType ?? target.contentType;
    const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: viewableTypes.test(type) ? type : "text/plain;charset=utf-8" }));
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  catch (error) {
    tab.close();
    toast.error(error instanceof Error ? `Couldn't open ${target.name}. ${error.message}` : `Couldn't open ${target.name}.`);
  }
}

onMounted(async () => {
  rememberConsoleSection("blob");
  readOnly.value = await isConsoleSectionReadOnly(props.sectionsBase, "blob");
});
</script>

<template>
    <ConsoleSearch :agents-base="agentsBase" :definitions-base="definitionsBase" :kv-base="kvBase" :search-base="searchBase" :sections-base="sectionsBase" />

    <UDashboardPanel id="blob-objects">
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
          @activate="openContents"
        >
          <template #toolbar>
            <USelect v-if="stores.length > 1" v-model="store" class="w-36" :items="storeItems" aria-label="Blob store" />
            <USwitch v-model="showVitehub" label="Show ViteHub files" size="xs" />
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
          @open="openContents(active)"
        />
        <UEmpty
          v-else-if="activeError"
          variant="naked"
          class="vitehub-media-library__detail justify-center"
          icon="i-lucide-file-x"
          :title="`Couldn't open ${file}`"
          :description="activeError"
          :actions="[{ label: 'Close', variant: 'outline', onClick: () => open(undefined) }]"
        />
      </div>
    </UDashboardPanel>
</template>
