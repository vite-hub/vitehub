<script setup lang="ts">
import type { TableColumn, TableRow } from "@nuxt/ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { appendUniqueConsoleKeys, requestConsole } from "../client/request";
import { rememberConsoleSection } from "../sections";
import ConsoleBrand from "./console-brand.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleSearch from "./console-search.vue";

interface KVListResponse {
  cursor?: string;
  error?: string;
  errorCode?: "cursor_expired";
  keys: string[];
  limit: number;
  prefix: string;
  store: string;
  stores: string[];
}

interface KVValueResponse {
  found: boolean;
  format?: "json" | "text";
  key: string;
  store: string;
  truncated?: boolean;
  type?: string;
  value?: string;
}

interface KVRow {
  key: string;
  store: string;
}

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
const stores = ref<string[]>([]);
const selectedStore = ref("default");
const keys = ref<string[]>([]);
const nextCursor = ref<string>();
const selectedKey = ref<string>();
const selectedValue = ref<KVValueResponse>();
const listLoading = ref(true);
const valueLoading = ref(false);
const listError = ref<unknown>();
const valueError = ref<unknown>();
let listRequest: AbortController | undefined;
let valueRequest: AbortController | undefined;
let applyingRouteSelection = false;

const storeItems = computed(() => stores.value.map((store) => ({ label: store, value: store })));
const tableRows = computed<KVRow[]>(() =>
  keys.value.map((key) => ({ key, store: selectedStore.value })),
);
const columns: TableColumn<KVRow>[] = [
  { accessorKey: "key", header: "Key" },
  { accessorKey: "store", header: "Store" },
];
const tableMeta = computed(() => ({
  class: {
    tr: (row: TableRow<KVRow>) => (row.original.key === selectedKey.value ? "bg-elevated/60" : ""),
  },
}));

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function parseList(value: unknown): KVListResponse {
  const source = record(value);
  if (!source || !Array.isArray(source.keys) || !Array.isArray(source.stores)) {
    throw new TypeError("The Console returned an invalid KV key list.");
  }
  return {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    cursor: typeof source.cursor === "string" ? source.cursor : undefined,
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    error: typeof source.error === "string" ? source.error : undefined,
    errorCode: source.errorCode === "cursor_expired" ? source.errorCode : undefined,
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate every key before rendering it.
    keys: source.keys.filter((key): key is string => typeof key === "string"),
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate the optional limit at this boundary.
    limit: typeof source.limit === "number" ? source.limit : 200,
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate the optional prefix at this boundary.
    prefix: typeof source.prefix === "string" ? source.prefix : "",
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate the selected store at this boundary.
    store: typeof source.store === "string" ? source.store : "default",
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate every store identity before rendering it.
    stores: source.stores.filter((store): store is string => typeof store === "string"),
  };
}

function parseValue(value: unknown): KVValueResponse {
  const source = record(value);
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate required key and store identities at this boundary.
  if (!source || typeof source.key !== "string" || typeof source.store !== "string") {
    throw new TypeError("The Console returned an invalid KV value.");
  }
  const parsed: KVValueResponse = {
    found: source.found === true,
    key: source.key,
    store: source.store,
  };
  if (source.format === "json" || source.format === "text") parsed.format = source.format;
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate the optional type label at this boundary.
  if (typeof source.type === "string") parsed.type = source.type;
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate the optional serialized value at this boundary.
  if (typeof source.value === "string") parsed.value = source.value;
  if (source.truncated === true) parsed.truncated = true;
  return parsed;
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error
    ? error.message
    : error
      ? "The Console could not load this KV data."
      : undefined;
}

async function loadValue(key = selectedKey.value): Promise<void> {
  valueRequest?.abort();
  selectedValue.value = undefined;
  valueError.value = undefined;
  if (key === undefined) return;
  const controller = new AbortController();
  valueRequest = controller;
  valueLoading.value = true;
  try {
    const value = parseValue(
      await requestConsole(props.kvBase, {
        body: { key, store: selectedStore.value },
        method: "POST",
        signal: controller.signal,
      }),
    );
    if (valueRequest === controller) selectedValue.value = value;
  } catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return;
    if (valueRequest === controller) valueError.value = error;
  } finally {
    if (valueRequest === controller) {
      valueRequest = undefined;
      valueLoading.value = false;
    }
  }
}

async function loadKeys(
  options: { append?: boolean; keepMissingSelection?: boolean; keepSelection?: boolean } = {},
): Promise<void> {
  listRequest?.abort();
  const currentSelection = options.keepSelection ? selectedKey.value : undefined;
  const controller = new AbortController();
  listRequest = controller;
  listLoading.value = true;
  let retryExpiredCursor = false;
  if (!options.append) {
    valueRequest?.abort();
    valueRequest = undefined;
    valueLoading.value = false;
    keys.value = [];
    nextCursor.value = undefined;
    selectedKey.value = undefined;
    selectedValue.value = undefined;
    valueError.value = undefined;
  }
  try {
    const value = parseList(
      await requestConsole(props.kvBase, {
        query: {
          cursor: options.append ? nextCursor.value : undefined,
          store: selectedStore.value,
        },
        signal: controller.signal,
      }),
    );
    if (listRequest !== controller) return;
    stores.value = value.stores;
    if (value.error) {
      const error = new Error(value.error);
      if (value.errorCode) Object.assign(error, { code: value.errorCode });
      throw error;
    }
    keys.value = options.append ? appendUniqueConsoleKeys(keys.value, value.keys) : value.keys;
    nextCursor.value = value.cursor;
    listError.value = undefined;
    const selection =
      options.append && options.keepSelection && selectedKey.value !== currentSelection
        ? selectedKey.value
        : currentSelection;
    selectedKey.value = selection !== undefined &&
        (options.keepMissingSelection || keys.value.includes(selection))
      ? selection
      : keys.value[0];
    await loadValue();
  } catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return;
    if (listRequest === controller) {
      retryExpiredCursor =
        options.append === true &&
        error instanceof Object &&
        "code" in error &&
        error.code === "cursor_expired";
      if (!retryExpiredCursor) listError.value = error;
    }
  } finally {
    if (listRequest === controller) {
      listRequest = undefined;
      listLoading.value = false;
    }
  }
  if (retryExpiredCursor) await loadKeys({ keepSelection: true });
}

async function selectKey(key: string): Promise<void> {
  selectedKey.value = key;
  sidebarOpen.value = false;
  syncRouteSelection();
  await loadValue(key);
}

function selectRow(_event: Event, row: TableRow<KVRow>): void {
  void selectKey(row.original.key);
}

async function refresh(): Promise<void> {
  await loadKeys({ keepSelection: true });
}

async function loadMore(): Promise<void> {
  await loadKeys({ append: true, keepSelection: true });
}

function syncRouteSelection(): void {
  if (
    route.query.store === selectedStore.value &&
    route.query.key === selectedKey.value
  )
    return;
  void router.replace({
    query: { ...route.query, key: selectedKey.value, store: selectedStore.value },
  });
}

watch(selectedStore, async () => {
  if (applyingRouteSelection) return;
  selectedKey.value = undefined;
  await loadKeys();
  syncRouteSelection();
});

async function applyRouteSelection(): Promise<void> {
  const store = route.query.store;
  const key = route.query.key;
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router query values require string narrowing before KV lookup.
  if (typeof store !== "string") {
    if (selectedStore.value === "default" && selectedKey.value === undefined) return;
    applyingRouteSelection = true;
    selectedStore.value = "default";
    selectedKey.value = undefined;
    try {
      await loadKeys();
    } finally {
      applyingRouteSelection = false;
    }
    return;
  }
  if (typeof key !== "string") {
    if (selectedStore.value === store && selectedKey.value === undefined) return;
    applyingRouteSelection = true;
    selectedStore.value = store;
    selectedKey.value = undefined;
    try {
      await loadKeys();
    } finally {
      applyingRouteSelection = false;
    }
    return;
  }
  if (selectedStore.value === store && selectedKey.value === key) return;
  applyingRouteSelection = true;
  selectedStore.value = store;
  selectedKey.value = key;
  try {
    await loadKeys({ keepMissingSelection: true, keepSelection: true });
  } finally {
    applyingRouteSelection = false;
  }
}

onMounted(() => {
  rememberConsoleSection("kv");
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router query values require string narrowing before KV lookup.
  if (typeof route.query.store === "string") {
    void applyRouteSelection();
  } else void loadKeys();
});

watch(
  () => [route.query.store, route.query.key],
  () => void applyRouteSelection(),
);

onBeforeUnmount(() => {
  listRequest?.abort();
  valueRequest?.abort();
});
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="kv-keys"
      v-model:open="sidebarOpen"
      v-model:collapsed="sidebarCollapsed"
      :default-size="20"
      :collapsed-size="4"
      :min-size="16"
      :max-size="26"
      :menu="{ title: 'KV', description: 'Inspect configured KV stores.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'border-t border-default px-2 py-1.5' }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <ConsoleBrand :collapsed="collapsed" :sections-base="sectionsBase" />
      </template>

      <template #default="{ collapsed }">
        <div class="px-2 py-2">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="w-full bg-transparent ring-0 hover:bg-elevated/60"
            label="Search console"
          />
        </div>
      </template>

      <template #footer="{ collapsed, collapse }">
        <ConsolePrimitiveSwitcher
          active="kv"
          :collapsed="collapsed"
          :sections-base="sectionsBase"
        />
        <UButton
          class="max-lg:hidden"
          :class="collapsed ? '' : 'ml-auto'"
          icon="i-ph-sidebar-simple-light"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="collapsed ? 'Show sidebar' : 'Hide sidebar'"
          @click="collapse(!collapsed)"
        />
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="kv-value" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <template #header>
        <UDashboardNavbar
          title="KV"
          :toggle="{ 'aria-label': 'Open sidebar' }"
          :ui="{ root: 'border-b border-default' }"
        >
          <template #right>
            <span class="hidden text-xs text-muted sm:inline"
              >{{ keys.length }} {{ keys.length === 1 ? "key" : "keys" }}</span
            >
            <USelect
              v-if="stores.length > 1"
              v-model="selectedStore"
              class="w-36"
              :items="storeItems"
              aria-label="KV store"
            />
            <span v-else class="hidden font-mono text-xs text-muted sm:inline">{{
              selectedStore
            }}</span>
            <UTooltip text="Refresh keys">
              <UButton
                aria-label="Refresh keys"
                color="neutral"
                icon="i-ph-arrows-clockwise-light"
                size="xs"
                variant="ghost"
                :loading="listLoading || valueLoading"
                @click="refresh"
              />
            </UTooltip>
            <UBadge color="neutral" label="Read-only" size="sm" variant="subtle" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <main class="min-h-0 flex-1 overflow-y-auto">
          <UAlert
            v-if="errorMessage(listError)"
            class="m-3"
            color="error"
            variant="subtle"
            icon="i-ph-cloud-slash-light"
            title="Could not load keys"
            :description="errorMessage(listError)"
            :actions="[
              { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: refresh },
            ]"
          />
          <template v-else>
            <UTable
              :columns="columns"
              :data="tableRows"
              empty="No keys in this store."
              :loading="listLoading"
              :meta="tableMeta"
              sticky="header"
              :on-select="selectRow"
              :ui="{
                root: 'max-h-[42vh] border-b border-default',
                tr: 'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
              }"
            >
              <template #key-cell="{ row }">
                <span class="flex min-w-0 items-center gap-2 font-mono text-xs text-highlighted">
                  <UIcon name="i-ph-key-light" class="size-3.5 shrink-0 text-muted opacity-65" />
                  <span class="truncate">{{ row.original.key || "(empty key)" }}</span>
                </span>
              </template>
              <template #store-cell="{ row }">
                <span class="font-mono text-[11px] text-muted">{{ row.original.store }}</span>
              </template>
            </UTable>
            <div v-if="nextCursor" class="border-b border-default px-3 py-2">
              <UButton
                color="neutral"
                label="Load more"
                size="xs"
                variant="ghost"
                :loading="listLoading"
                @click="loadMore"
              />
            </div>
          </template>

          <div v-if="valueLoading && !selectedValue" class="flex h-24 items-center justify-center">
            <UIcon
              name="i-ph-circle-notch-light"
              class="size-4 animate-spin text-muted opacity-70"
            />
          </div>
          <UAlert
            v-else-if="errorMessage(valueError)"
            class="m-3"
            color="error"
            variant="subtle"
            icon="i-ph-cloud-slash-light"
            title="Could not load this value"
            :description="errorMessage(valueError)"
            :actions="[
              {
                label: 'Try again',
                icon: 'i-ph-arrows-clockwise-light',
                onClick: () => loadValue(),
              },
            ]"
          />
          <UAlert
            v-else-if="selectedValue && !selectedValue.found"
            class="m-3"
            color="warning"
            variant="subtle"
            icon="i-ph-key-light"
            title="Key no longer exists"
            description="Refresh the table to load the current store contents."
          />
          <section v-else-if="selectedValue" class="min-w-0">
            <header
              class="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-b border-default px-3 py-2"
            >
              <h2 class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-highlighted">
                {{ selectedValue.key || "(empty key)" }}
              </h2>
              <span class="font-mono text-[10px] uppercase tracking-[.08em] text-muted">{{
                selectedValue.type
              }}</span>
              <span class="font-mono text-[10px] uppercase tracking-[.08em] text-muted">{{
                selectedValue.format
              }}</span>
              <UBadge
                v-if="selectedValue.truncated"
                color="warning"
                label="Truncated at 256 KiB"
                size="sm"
                variant="subtle"
              />
            </header>
            <pre
              class="min-h-48 overflow-auto p-4 font-mono text-xs leading-5 text-toned"
            ><code>{{ selectedValue.value }}</code></pre>
          </section>
        </main>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
