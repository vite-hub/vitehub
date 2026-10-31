<script setup lang="ts">
import type { LocationQueryValue } from "vue-router";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { appendUniqueConsoleKeys, requestConsole } from "../client/request";
import { useConsoleToast } from "../client/toast";
import { isConsoleSectionReadOnly } from "../client/read-only";
import { rememberConsoleSection } from "../sections";
import { consoleBytes } from "../client/format";
import ConsoleFrame from "./console-frame.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";
import ConsoleStatus from "./console-status.vue";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";

interface KVListResponse {
  cursor?: string;
  keys: string[];
  limit: number;
  prefix: string;
  store: string;
  stores: string[];
}

interface KVValueResponse {
  editable?: boolean;
  found: boolean;
  /** `unknown`: the key may expire, and the store cannot say when. `none`: the store never expires keys. */
  expiry?: "none" | "unknown";
  format?: "json" | "text";
  key: string;
  store: string;
  truncated?: boolean;
  type?: string;
  value?: string;
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
const loadedStore = ref<string>();
const toast = useConsoleToast();
/** The access may only read KV (`"kv:read"`), so the page offers no edit or delete. */
const readOnly = ref(false);
const editing = ref(false);
const editText = ref("");
/** Seconds until the edited key expires. Empty: no expiry. */
const editTtl = ref("");
const editError = ref<string>();
const saving = ref(false);
const removeOpen = ref(false);
const removing = ref(false);
let listRequest: AbortController | undefined;
let valueRequest: AbortController | undefined;
let applyingRouteSelection = false;

const storeItems = computed(() => stores.value.map((store) => ({ label: store, value: store })));
/** The KV route truncates large values at this size. */
const valueLimit = 256 * 1024;
const keyFilter = ref("");
// The filter narrows the loaded keys. Load more to search further in a large store.
const visibleKeys = computed(() => {
  const filter = keyFilter.value.trim().toLowerCase();
  return filter ? keys.value.filter(key => key.toLowerCase().includes(filter)) : keys.value;
});
const keyCount = computed(() => `${keys.value.length}${nextCursor.value ? "+" : ""} ${keys.value.length === 1 && !nextCursor.value ? "key" : "keys"}`);
// The namespace before the last `:`, such as `cache:nitro:`, shows dimmed so the last segment reads first.
function keyPrefix(key: string): string {
  const index = key.lastIndexOf(":");
  return index > 0 && index < key.length - 1 ? key.slice(0, index + 1) : "";
}
const valueFormat = computed(() => [selectedValue.value?.type, selectedValue.value?.format?.toUpperCase()].filter(Boolean).join(" · "));

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function queryString(value: LocationQueryValue | LocationQueryValue[]): string | undefined {
  return value === null || Array.isArray(value) ? undefined : value;
}

function parseList(value: unknown): KVListResponse {
  const source = record(value);
  if (!source || !Array.isArray(source.keys) || !Array.isArray(source.stores)) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0103({ message: "The Console returned an invalid KV key list." });
  }
  return {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    cursor: typeof source.cursor === "string" ? source.cursor : undefined,
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate every key before rendering it.
    keys: source.keys.filter((key): key is string => typeof key === "string"),
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate the optional limit at this boundary.
    limit: typeof source.limit === "number" ? source.limit : 100,
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
    throw viteHubErrorDiagnostics.VITE_HUB_R0104({ message: "The Console returned an invalid KV value." });
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
  parsed.editable = source.editable === true;
  if (source.expiry === "none" || source.expiry === "unknown") parsed.expiry = source.expiry;
  return parsed;
}

/** ViteHub keeps its own state under `vitehub:`. The keys can be read here, not changed. */
const reserved = computed(() => (selectedValue.value?.key ?? "").replaceAll(/[/\\]/g, ":").replace(/^:+/, "").toLowerCase().startsWith("vitehub:"));

/** Only complete previews that round-trip through text/JSON can be edited. */
const editable = computed(() => {
  const value = selectedValue.value;
  return Boolean(value?.found && value.editable) && !value?.truncated && !reserved.value && !readOnly.value;
});

function startEdit(): void {
  editText.value = selectedValue.value?.value ?? "";
  editTtl.value = "";
  editError.value = undefined;
  editing.value = true;
}

/** A string stays text. Any other type is written as the JSON that the editor shows. */
function editedValue(): unknown {
  if (selectedValue.value?.type === "string") return editText.value;
  try {
    return JSON.parse(editText.value);
  } catch {
    throw new Error("This value is not valid JSON.");
  }
}

async function saveEdit(): Promise<void> {
  const key = selectedKey.value;
  const store = selectedStore.value;
  if (key === undefined || saving.value) return;
  saving.value = true;
  editError.value = undefined;
  try {
    const value = editedValue();
    const ttl = editTtl.value.trim() === "" ? undefined : Number(editTtl.value);
    if (ttl !== undefined && !(Number.isFinite(ttl) && ttl > 0)) {
      editError.value = "Expires in must be a positive number of seconds, or empty for no expiry.";
      return;
    }
    await requestConsole(props.kvBase, { body: { action: "set", key, store, ...(ttl === undefined ? {} : { ttl }), value }, method: "POST" });
    toast.show({ title: "Value saved" });
    if (selectedKey.value === key && selectedStore.value === store) {
      editing.value = false;
      await loadValue(key);
    }
  } catch (error) {
    editError.value = errorMessage(error) ?? "The Console could not save this value.";
  } finally {
    saving.value = false;
  }
}

async function confirmRemove(): Promise<void> {
  const key = selectedKey.value;
  if (key === undefined || removing.value) return;
  removing.value = true;
  try {
    await requestConsole(props.kvBase, { body: { action: "del", key, store: selectedStore.value }, method: "POST" });
    removeOpen.value = false;
    toast.show({ title: "Key deleted" });
    selectedKey.value = undefined;
    syncRouteSelection();
    await loadKeys();
  } catch (error) {
    removeOpen.value = false;
    toast.error(errorMessage(error) ?? "The Console could not delete this key.");
  } finally {
    removing.value = false;
  }
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
  editing.value = false;
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
    keys.value = options.append ? appendUniqueConsoleKeys(keys.value, value.keys) : value.keys;
    nextCursor.value = value.cursor;
    listError.value = undefined;
    loadedStore.value = value.store;
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
        error.code === "KV_INVALID_CURSOR";
      if (!retryExpiredCursor) listError.value = error;
    }
  } finally {
    if (listRequest === controller) {
      listRequest = undefined;
      listLoading.value = false;
    }
  }
  if (retryExpiredCursor) await loadKeys({ keepMissingSelection: true, keepSelection: true });
}

async function selectKey(key: string): Promise<void> {
  selectedKey.value = key;
  syncRouteSelection();
  await loadValue(key);
}

async function refresh(): Promise<void> {
  await loadKeys({ keepMissingSelection: true, keepSelection: true });
}

async function loadMore(): Promise<void> {
  await loadKeys({ append: true, keepMissingSelection: true, keepSelection: true });
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
  const store = queryString(route.query.store);
  const key = queryString(route.query.key);
  if (store === undefined) {
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
  if (key === undefined) {
    if (
      selectedStore.value === store &&
      selectedKey.value === undefined &&
      loadedStore.value === store
    )
      return;
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
  void isConsoleSectionReadOnly(props.sectionsBase, "kv").then((value) => { readOnly.value = value; });
  rememberConsoleSection("kv");
  if (queryString(route.query.store) !== undefined) {
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
  <ConsoleFrame active="kv" :sections-base="sectionsBase">
    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="kv-value" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <ConsolePageHeader title="KV" :description="stores.length > 1 ? undefined : selectedStore" :toggle="false">
        <template #right>
                    <UTooltip text="Refresh keys">
            <UButton aria-label="Refresh keys" icon="i-lucide-refresh-cw" size="sm" variant="ghost" :loading="listLoading || valueLoading" @click="refresh" />
          </UTooltip>
        </template>
      </ConsolePageHeader>
      <ConsolePageToolbar v-if="stores.length > 1 || keys.length">
        <USelect v-if="stores.length > 1" v-model="selectedStore" class="w-40" size="sm" :items="storeItems" aria-label="KV store" />
        <UInput v-model="keyFilter" class="w-full sm:w-64" icon="i-lucide-search" size="sm" placeholder="Filter loaded keys…" aria-label="Filter loaded keys" />
        <span class="ms-auto text-xs text-muted tabular-nums" aria-live="polite">{{ keyFilter.trim() ? `${visibleKeys.length} of ${keyCount}` : keyCount }}</span>
      </ConsolePageToolbar>

      <ConsoleState v-if="listError" :error="listError" title="Could not load keys" :retry="refresh" />
      <div v-else class="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav class="flex max-h-[40vh] min-h-0 shrink-0 flex-col overflow-y-auto border-b border-default p-2 md:max-h-none md:w-80 md:border-r md:border-b-0" aria-label="Keys">
          <template v-if="listLoading && !keys.length">
            <USkeleton v-for="index in 8" :key="index" class="my-0.5 h-8 rounded-md" />
          </template>
          <template v-else-if="visibleKeys.length">
            <button
              v-for="key in visibleKeys"
              :key="key"
              type="button"
              class="vitehub-console__section-link shrink-0 text-start"
              :aria-current="key === selectedKey ? 'true' : undefined"
              :title="key"
              @click="selectKey(key)"
            >
              <span class="flex min-w-0 flex-1 font-mono text-xs">
                <span v-if="keyPrefix(key)" class="min-w-0 truncate text-dimmed">{{ keyPrefix(key) }}</span>
                <span class="max-w-[80%] shrink-0 truncate">{{ key.slice(keyPrefix(key).length) || "(empty key)" }}</span>
              </span>
            </button>
            <UButton v-if="nextCursor" class="mt-1 self-start" label="Load more" size="sm" variant="ghost" :loading="listLoading" @click="loadMore" />
          </template>
          <p v-else-if="keys.length" class="px-2 py-1.5 text-xs text-muted">No loaded keys match “{{ keyFilter.trim() }}”.</p>
          <p v-else class="px-2 py-1.5 text-xs text-muted">No keys in this store yet.</p>
        </nav>

        <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Value">
          <div v-if="valueLoading && !selectedValue" class="grid gap-2 p-4" aria-busy="true">
            <USkeleton class="h-4 w-56" />
            <USkeleton v-for="index in 6" :key="index" class="h-3.5" :class="index % 2 ? 'w-2/3' : 'w-1/2'" />
          </div>
          <ConsoleState v-else-if="valueError" :error="valueError" title="Could not load this value" :retry="() => loadValue()" />
          <UEmpty
            v-else-if="selectedValue && !selectedValue.found"
            variant="naked"
            class="py-16"
            icon="i-lucide-key-round"
            title="This key no longer exists"
            description="Someone deleted it after the list loaded. Refresh to load the current keys."
            :actions="[{ label: 'Refresh', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: refresh }]"
          />
          <template v-else-if="selectedValue">
            <header class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-default px-4 py-2">
              <h2 class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-highlighted" :title="selectedValue.key">
                {{ selectedValue.key || "(empty key)" }}
              </h2>
              <ConsoleStatus v-if="selectedValue.truncated" tone="warning" :label="`Truncated at ${consoleBytes(valueLimit)}`" />
              <span v-if="valueFormat" class="text-xs text-muted">{{ valueFormat }}</span>
              <template v-if="!editing">
                <UTooltip :text="editable ? 'Edit value' : readOnly ? 'This access can only read KV' : reserved ? 'ViteHub keeps this key for itself' : 'Bytes and cut values are read only'">
                  <UButton aria-label="Edit value" icon="i-lucide-pencil" size="sm" variant="ghost" :disabled="!editable" @click="startEdit" />
                </UTooltip>
                <UTooltip text="Delete key">
                  <UButton aria-label="Delete key" color="error" icon="i-lucide-trash-2" size="sm" variant="ghost" :disabled="reserved || readOnly" @click="removeOpen = true" />
                </UTooltip>
              </template>
            </header>
            <div v-if="editing" class="flex min-h-0 flex-1 flex-col gap-2 p-4">
              <UTextarea v-model="editText" class="min-h-0 flex-1 items-stretch" :rows="12" :ui="{ base: 'font-mono text-xs' }" aria-label="Value" autofocus />
              <div class="flex flex-wrap items-center gap-2">
                <UInput v-model="editTtl" class="w-40" size="sm" type="number" min="1" placeholder="No expiry" aria-label="Expires in seconds" />
                <span class="text-xs text-muted">Expires in seconds</span>
              </div>
              <p v-if="selectedValue.expiry === 'unknown'" class="text-xs text-warning" role="status">
                This store cannot report when the key expires. Saving replaces the value and removes any expiry unless you set one here.
              </p>
              <p v-if="editError" class="text-xs text-error" role="alert">{{ editError }}</p>
              <div class="flex justify-end gap-2">
                <UButton label="Cancel" variant="ghost" :disabled="saving" @click="editing = false" />
                <UButton label="Save" :loading="saving" @click="saveEdit" />
              </div>
            </div>
            <pre v-else class="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-5 text-toned"><code>{{ selectedValue.value }}</code></pre>
          </template>
          <UEmpty
            v-else-if="!listLoading"
            variant="naked"
            class="py-16"
            icon="i-lucide-database"
            :title="keys.length ? 'No key selected' : 'This store is empty'"
            :description="keys.length ? 'Choose a key to see its value.' : 'Keys show here when the application writes them.'"
          />
        </section>
      </div>
    </UDashboardPanel>

    <UModal v-model:open="removeOpen" title="Delete this key?" :ui="{ content: 'sm:max-w-[440px]' }">
      <template #body>
        <p class="text-[13px] text-muted">
          <span class="font-mono text-xs text-highlighted">{{ selectedKey || "(empty key)" }}</span> is deleted from the store <span class="font-medium">{{ selectedStore }}</span>. This cannot be undone.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" label="Cancel" @click="removeOpen = false" />
          <UButton color="error" label="Delete" :loading="removing" @click="confirmRemove" />
        </div>
      </template>
    </UModal>
  </ConsoleFrame>
</template>
