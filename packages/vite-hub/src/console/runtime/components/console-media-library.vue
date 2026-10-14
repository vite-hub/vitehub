<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { consoleErrorMessage } from "../client/documents";
import { rememberConsoleMediaFolder } from "../client/media-library";
import ConsoleMediaBrowser from "./console-media-browser.vue";
import ConsoleMediaDetail from "./console-media-detail.vue";

import type { ConsoleMediaAccess, ConsoleMediaClient, ConsoleMediaFile } from "../client/media-library";

/**
 * The Media page of a document editor section: the files of the served Blob Store with folders, uploads, bulk moves and
 * deletes, and a detail panel for alt text, the focal point, and crops. The folder and the open file live in the URL, so
 * a link opens the same view.
 */
const props = defineProps<{
  client: ConsoleMediaClient;
  label: string;
  section: string;
}>();

const route = useRoute();
const router = useRouter();
const browser = ref<InstanceType<typeof ConsoleMediaBrowser>>();
const access = ref<ConsoleMediaAccess>({ manage: false, read: true, write: false });
const served = ref<string | null>(null);
const selected = ref<string[]>([]);
const active = shallowRef<ConsoleMediaFile>();
const activeError = ref<unknown>();

function query(name: string): string {
  const value = route.query[name];
  return String(value) === value ? value : "";
}

const folder = computed({
  get: () => query("folder"),
  set: (value: string) => {
    void router.replace({ query: { ...route.query, file: undefined, folder: value || undefined } });
  },
});

watch(folder, value => rememberConsoleMediaFolder(props.section, value), { immediate: true });

// `?file=` opens the details of one file, also after a reload.
watch(() => query("file"), async (pathname) => {
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

function open(file: ConsoleMediaFile | undefined): void {
  active.value = file;
  void router.replace({ query: { ...route.query, file: file?.pathname } });
}

function updated(file: ConsoleMediaFile): void {
  active.value = file;
  browser.value?.replace(file);
}
</script>

<template>
  <UDashboardNavbar :ui="{ root: 'border-b border-default' }" :toggle="{ 'aria-label': 'Open section navigation' }">
    <template #title>
      <span class="truncate text-sm font-semibold text-highlighted">{{ label }}</span>
    </template>
    <template #right>
      <span v-if="!access.write" class="text-xs text-dimmed">Read-only</span>
      <span v-else-if="!access.manage" class="text-xs text-dimmed">Moving and deleting needs publish access</span>
    </template>
  </UDashboardNavbar>
  <div class="relative flex min-h-0 flex-1">
    <ConsoleMediaBrowser
      ref="browser"
      v-model:folder="folder"
      v-model:selected="selected"
      mode="page"
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
      <p class="text-sm text-highlighted">Couldn't open {{ query("file") }}</p>
      <p class="text-xs text-muted">{{ consoleErrorMessage(activeError) }}</p>
      <UButton variant="outline" size="sm" label="Close" @click="open(undefined)" />
    </div>
  </div>
</template>

<style>
/* The details sit next to the files on wide screens and cover them on narrow ones. */
.vitehub-media-library__detail {
  border-left: 1px solid var(--ui-border);
  flex-shrink: 0;
  width: 22.5rem;
}

@media (max-width: 1023px) {
  .vitehub-media-library__detail {
    background: var(--ui-bg);
    border-left: 0;
    inset: 0;
    position: absolute;
    width: auto;
    z-index: 40;
  }
}
</style>
