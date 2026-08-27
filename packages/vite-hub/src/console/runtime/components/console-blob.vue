<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { requestConsole } from "../client/request";
import { rememberConsoleSection } from "../sections";
import ConsoleBackButton from "./console-back-button.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSearch from "./console-search.vue";

interface BlobObjectResponse {
  contentType?: string;
  customMetadata: Record<string, string>;
  httpEtag?: string;
  httpMetadata: Record<string, string>;
  pathname: string;
  size?: number;
  uploadedAt: string;
  urlAvailable?: true;
}

interface BlobPageResponse {
  blobs: BlobObjectResponse[];
  cursor?: string;
  hasMore: boolean;
  limit: number;
  prefix: string;
  store: string;
  stores: string[];
}

const props = defineProps<{
  agentsBase: string;
  blobBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
const stores = ref<string[]>([]);
const selectedStore = ref("default");
const prefix = ref("");
const blobs = ref<BlobObjectResponse[]>([]);
const cursor = ref<string>();
const hasMore = ref(false);
const selectedPath = ref<string>();
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<unknown>();
let request: AbortController | undefined;
let prefixTimer: ReturnType<typeof setTimeout> | undefined;

const storeItems = computed(() => stores.value.map(store => ({ label: store, value: store })));
const selectedBlob = computed(() => blobs.value.find(blob => blob.pathname === selectedPath.value));
const httpMetadata = computed(() => Object.entries(selectedBlob.value?.httpMetadata ?? {}).sort(([left], [right]) => left.localeCompare(right)));
const customMetadata = computed(() => Object.entries(selectedBlob.value?.customMetadata ?? {}).sort(([left], [right]) => left.localeCompare(right)));

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  const source = record(value);
  if (!source || Object.values(source).some(item => typeof item !== "string")) {
    throw new TypeError("The Console returned invalid Blob metadata.");
  }
  return source as Record<string, string>;
}

function parseBlob(value: unknown): BlobObjectResponse {
  const source = record(value);
  if (!source || typeof source.pathname !== "string" || typeof source.uploadedAt !== "string") {
    throw new TypeError("The Console returned an invalid Blob object.");
  }
  const object: BlobObjectResponse = {
    customMetadata: stringRecord(source.customMetadata),
    httpMetadata: stringRecord(source.httpMetadata),
    pathname: source.pathname,
    uploadedAt: source.uploadedAt,
  };
  if (typeof source.contentType === "string") object.contentType = source.contentType;
  if (typeof source.httpEtag === "string") object.httpEtag = source.httpEtag;
  if (typeof source.size === "number" && Number.isFinite(source.size)) object.size = source.size;
  if (source.urlAvailable === true) object.urlAvailable = true;
  return object;
}

function parsePage(value: unknown): BlobPageResponse {
  const source = record(value);
  if (!source || !Array.isArray(source.blobs) || !Array.isArray(source.stores)) {
    throw new TypeError("The Console returned an invalid Blob page.");
  }
  return {
    blobs: source.blobs.map(parseBlob),
    cursor: typeof source.cursor === "string" ? source.cursor : undefined,
    hasMore: source.hasMore === true,
    limit: typeof source.limit === "number" ? source.limit : 100,
    prefix: typeof source.prefix === "string" ? source.prefix : "",
    store: typeof source.store === "string" ? source.store : "default",
    stores: source.stores.filter((store): store is string => typeof store === "string"),
  };
}

function errorMessage(value: unknown): string | undefined {
  return value instanceof Error
    ? value.message
    : value
      ? "The Console could not load Blob metadata."
      : undefined;
}

function formatBytes(value: number | undefined): string {
  if (typeof value !== "number") return "Unknown";
  if (value < 1_024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value / 1_024;
  let unit = 0;
  while (size >= 1_024 && unit < units.length - 1) {
    size /= 1_024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

async function loadObjects(options: { append?: boolean; keepSelection?: boolean } = {}): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  if (options.append) loadingMore.value = true;
  else loading.value = true;
  try {
    const page = parsePage(await requestConsole(props.blobBase, {
      query: {
        cursor: options.append ? cursor.value : undefined,
        prefix: prefix.value || undefined,
        store: selectedStore.value,
      },
      signal: controller.signal,
    }));
    if (request !== controller) return;
    stores.value = page.stores;
    const next = options.append
      ? [...blobs.value, ...page.blobs.filter(candidate => !blobs.value.some(object => object.pathname === candidate.pathname))]
      : page.blobs;
    blobs.value = next;
    cursor.value = page.cursor;
    hasMore.value = page.hasMore;
    error.value = undefined;
    const current = options.keepSelection ? selectedPath.value : undefined;
    selectedPath.value = current && next.some(object => object.pathname === current)
      ? current
      : next[0]?.pathname;
  } catch (cause) {
    if (cause instanceof Object && "name" in cause && cause.name === "AbortError") return;
    if (request === controller) error.value = cause;
  } finally {
    if (request === controller) {
      request = undefined;
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function selectBlob(pathname: string): void {
  selectedPath.value = pathname;
  sidebarOpen.value = false;
}

async function refresh(): Promise<void> {
  cursor.value = undefined;
  await loadObjects({ keepSelection: true });
}

watch(selectedStore, () => {
  selectedPath.value = undefined;
  cursor.value = undefined;
  void loadObjects();
});

watch(prefix, () => {
  if (prefixTimer) clearTimeout(prefixTimer);
  prefixTimer = setTimeout(() => {
    selectedPath.value = undefined;
    cursor.value = undefined;
    void loadObjects();
  }, 200);
});

onMounted(() => {
  rememberConsoleSection("blob");
  void loadObjects();
});

onBeforeUnmount(() => {
  request?.abort();
  if (prefixTimer) clearTimeout(prefixTimer);
});
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="blob-objects"
      v-model:open="sidebarOpen"
      v-model:collapsed="sidebarCollapsed"
      :default-size="21"
      :collapsed-size="4"
      :min-size="17"
      :max-size="28"
      :menu="{ title: 'Blob objects', description: 'Browse configured Blob stores.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'border-t border-default px-3 py-2' }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <div class="flex h-10 w-full min-w-0 items-center gap-2.5 px-1.5">
          <ConsoleMark />
          <span v-if="!collapsed" class="grid min-w-0 flex-1 leading-none">
            <small class="truncate text-[10px] font-bold uppercase tracking-[.12em] text-muted">ViteHub Console</small>
            <strong class="mt-1 truncate text-sm font-semibold text-highlighted">Blob</strong>
          </span>
        </div>
      </template>

      <template #default="{ collapsed }">
        <div class="px-2 pt-2"><ConsoleBackButton :collapsed="collapsed" /></div>
        <div v-if="!collapsed" class="flex items-end justify-between px-4 pb-3 pt-5">
          <div>
            <span class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">Object storage</span>
            <h1 class="mt-1 text-lg font-semibold tracking-tight text-highlighted">Objects</h1>
          </div>
          <span class="text-xs text-muted">{{ blobs.length }}{{ hasMore ? "+" : "" }}</span>
        </div>
        <div class="px-2 pb-3" :class="collapsed ? 'pt-2' : ''">
          <UDashboardSearchButton :collapsed="collapsed" block class="w-full bg-transparent ring-default" label="Search console" />
        </div>
        <div v-if="!collapsed" class="grid gap-2 px-3 pb-3">
          <USelect v-if="stores.length > 1" v-model="selectedStore" :items="storeItems" aria-label="Blob store" size="sm" />
          <UInput v-model="prefix" aria-label="Filter objects by prefix" icon="i-lucide-search" placeholder="Filter by prefix" size="sm" />
        </div>
        <div v-if="!collapsed && errorMessage(error)" class="px-3 pb-3">
          <UAlert color="error" variant="subtle" icon="i-lucide-cloud-off" title="Could not load objects" :description="errorMessage(error)" :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: refresh }]" />
        </div>
        <div v-if="collapsed" class="min-h-0 flex-1 overflow-y-auto">
          <div class="grid gap-1 px-2 py-1">
            <UTooltip v-for="object in blobs" :key="object.pathname" :text="object.pathname" :content="{ side: 'right' }">
              <UButton icon="i-lucide-file" color="neutral" :variant="selectedPath === object.pathname ? 'soft' : 'ghost'" block :aria-label="object.pathname" @click="selectBlob(object.pathname)" />
            </UTooltip>
          </div>
        </div>
        <div v-else-if="loading && !blobs.length" class="grid gap-2 px-3"><USkeleton v-for="index in 6" :key="index" class="h-11 rounded-md" /></div>
        <nav v-else-if="blobs.length" class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Blob objects">
          <button v-for="object in blobs" :key="object.pathname" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary" :class="selectedPath === object.pathname ? 'bg-elevated text-highlighted' : 'text-toned'" @click="selectBlob(object.pathname)">
            <UIcon name="i-lucide-file" class="size-3.5 shrink-0 text-dimmed" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-mono text-xs">{{ object.pathname }}</span>
              <span class="mt-0.5 block truncate text-[11px] text-muted">{{ formatBytes(object.size) }} · {{ object.contentType || "Unknown type" }}</span>
            </span>
          </button>
          <UButton v-if="hasMore" class="mt-2" block color="neutral" icon="i-lucide-chevron-down" label="Load more" size="sm" variant="ghost" :loading="loadingMore" @click="loadObjects({ append: true, keepSelection: true })" />
        </nav>
        <UEmpty v-else-if="!loading && !error && !collapsed" class="min-h-0 flex-1 px-4" icon="i-lucide-file-box" :title="prefix ? 'No matching objects' : 'This store is empty'" :description="prefix ? 'Try a shorter object prefix.' : 'Objects will appear here when the application stores them.'" />
      </template>

      <template #footer="{ collapsed, collapse }">
        <span v-if="!collapsed" class="flex items-center gap-1.5 text-xs text-muted"><UIcon name="i-lucide-lock-keyhole" class="size-3.5" />Read-only</span>
        <UTooltip text="Refresh objects"><UButton aria-label="Refresh objects" color="neutral" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :loading="loading || loadingMore" @click="refresh" /></UTooltip>
        <UButton class="max-lg:hidden" :class="collapsed ? '' : 'ml-1'" :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" color="neutral" variant="ghost" size="xs" :aria-label="collapsed ? 'Show Blob objects' : 'Hide Blob objects'" @click="collapse(!collapsed)" />
      </template>
    </UDashboardSidebar>

    <ConsoleSearch :agents-base="agentsBase" :search-base="searchBase" :sections-base="sectionsBase" />

    <UDashboardPanel id="blob-object">
      <div class="flex min-h-0 flex-1 flex-col" aria-live="polite">
        <header class="flex h-14 shrink-0 items-center border-b border-default px-4">
          <UButton class="mr-2 lg:hidden" aria-label="Open Blob objects" color="neutral" icon="i-lucide-panel-left" variant="ghost" @click="sidebarOpen = true" />
          <div class="min-w-0">
            <p class="truncate font-mono text-xs font-medium text-highlighted">{{ selectedPath || "Blob" }}</p>
            <p v-if="selectedPath" class="mt-0.5 truncate text-[11px] text-muted">{{ selectedStore }}</p>
          </div>
          <UBadge class="ml-auto" color="neutral" label="Read-only" size="sm" variant="soft" />
        </header>

        <UEmpty v-if="!selectedBlob && !loading" class="min-h-0 flex-1" icon="i-lucide-mouse-pointer-click" title="Select an object" description="Choose an object to inspect metadata returned by its Blob store." />
        <div v-else-if="loading && !selectedBlob" class="flex min-h-0 flex-1 items-center justify-center"><UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" /></div>
        <main v-else-if="selectedBlob" class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div class="mx-auto w-full max-w-5xl">
            <section class="overflow-hidden rounded-lg border border-default bg-default">
              <div class="flex h-10 items-center border-b border-default px-3"><h2 class="text-xs font-medium text-highlighted">Object metadata</h2></div>
              <dl class="divide-y divide-default">
                <div v-for="field in [
                  ['Store', selectedStore],
                  ['Pathname', selectedBlob.pathname],
                  ['Content type', selectedBlob.contentType || 'Unknown'],
                  ['Size', formatBytes(selectedBlob.size)],
                  ['Uploaded', selectedBlob.uploadedAt],
                  ['HTTP ETag', selectedBlob.httpEtag || 'Unavailable'],
                  ['Access URL', selectedBlob.urlAvailable ? 'Available from the configured provider' : 'Unavailable'],
                ]" :key="field[0]" class="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
                  <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">{{ field[0] }}</dt>
                  <dd class="break-all font-mono text-xs text-highlighted">{{ field[1] }}</dd>
                </div>
              </dl>
            </section>

            <div class="mt-4 grid gap-4 lg:grid-cols-2">
              <section v-for="group in [{ title: 'HTTP metadata', entries: httpMetadata }, { title: 'Custom metadata', entries: customMetadata }]" :key="group.title" class="overflow-hidden rounded-lg border border-default bg-default">
                <div class="flex h-10 items-center border-b border-default px-3"><h2 class="text-xs font-medium text-highlighted">{{ group.title }}</h2><span class="ml-auto text-[11px] text-muted">{{ group.entries.length }}</span></div>
                <dl v-if="group.entries.length" class="divide-y divide-default">
                  <div v-for="entry in group.entries" :key="entry[0]" class="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                    <dt class="break-all font-mono text-[11px] text-muted">{{ entry[0] }}</dt>
                    <dd class="break-all font-mono text-xs text-highlighted">{{ entry[1] }}</dd>
                  </div>
                </dl>
                <p v-else class="px-4 py-5 text-sm text-muted">No metadata was returned for this object.</p>
              </section>
            </div>

            <UAlert class="mt-4" color="neutral" variant="subtle" icon="i-lucide-file-lock-2" title="Metadata only" description="The Console does not download object contents or expose Blob mutations." />
          </div>
        </main>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
