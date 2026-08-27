<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { requestConsole } from "../client/request";
import { rememberConsoleSection } from "../sections";
import ConsoleBackButton from "./console-back-button.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSearch from "./console-search.vue";

interface KVListResponse {
  keys: string[];
  limit: number;
  prefix: string;
  store: string;
  stores: string[];
  total: number;
  truncated: boolean;
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

const props = defineProps<{
  agentsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
const stores = ref<string[]>([]);
const selectedStore = ref("default");
const prefix = ref("");
const keys = ref<string[]>([]);
const total = ref(0);
const listTruncated = ref(false);
const selectedKey = ref<string>();
const selectedValue = ref<KVValueResponse>();
const listLoading = ref(true);
const valueLoading = ref(false);
const listError = ref<unknown>();
const valueError = ref<unknown>();
let listRequest: AbortController | undefined;
let valueRequest: AbortController | undefined;
let prefixTimer: ReturnType<typeof setTimeout> | undefined;

const storeItems = computed(() => stores.value.map(store => ({ label: store, value: store })));

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
    keys: source.keys.filter((key): key is string => typeof key === "string"),
    limit: typeof source.limit === "number" ? source.limit : 200,
    prefix: typeof source.prefix === "string" ? source.prefix : "",
    store: typeof source.store === "string" ? source.store : "default",
    stores: source.stores.filter((store): store is string => typeof store === "string"),
    total: typeof source.total === "number" ? source.total : source.keys.length,
    truncated: source.truncated === true,
  };
}

function parseValue(value: unknown): KVValueResponse {
  const source = record(value);
  if (!source || typeof source.key !== "string" || typeof source.store !== "string") {
    throw new TypeError("The Console returned an invalid KV value.");
  }
  return {
    found: source.found === true,
    key: source.key,
    store: source.store,
    ...(source.format === "json" || source.format === "text" ? { format: source.format } : {}),
    ...(typeof source.type === "string" ? { type: source.type } : {}),
    ...(typeof source.value === "string" ? { value: source.value } : {}),
    ...(source.truncated === true ? { truncated: true } : {}),
  };
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
  if (!key) return;
  const controller = new AbortController();
  valueRequest = controller;
  valueLoading.value = true;
  try {
    const value = parseValue(await requestConsole(props.kvBase, {
      query: { key, store: selectedStore.value },
      signal: controller.signal,
    }));
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

async function loadKeys(options: { keepSelection?: boolean } = {}): Promise<void> {
  listRequest?.abort();
  const controller = new AbortController();
  listRequest = controller;
  listLoading.value = true;
  try {
    const value = parseList(await requestConsole(props.kvBase, {
      query: { prefix: prefix.value || undefined, store: selectedStore.value },
      signal: controller.signal,
    }));
    if (listRequest !== controller) return;
    stores.value = value.stores;
    keys.value = value.keys;
    total.value = value.total;
    listTruncated.value = value.truncated;
    listError.value = undefined;
    const current = options.keepSelection ? selectedKey.value : undefined;
    selectedKey.value = current && value.keys.includes(current) ? current : value.keys[0];
    await loadValue();
  } catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return;
    if (listRequest === controller) listError.value = error;
  } finally {
    if (listRequest === controller) {
      listRequest = undefined;
      listLoading.value = false;
    }
  }
}

async function selectKey(key: string): Promise<void> {
  selectedKey.value = key;
  sidebarOpen.value = false;
  await loadValue(key);
}

async function refresh(): Promise<void> {
  await loadKeys({ keepSelection: true });
}

watch(selectedStore, () => {
  selectedKey.value = undefined;
  void loadKeys();
});

watch(prefix, () => {
  if (prefixTimer) clearTimeout(prefixTimer);
  prefixTimer = setTimeout(() => void loadKeys(), 200);
});

onMounted(() => {
  rememberConsoleSection("kv");
  void loadKeys();
});

onBeforeUnmount(() => {
  listRequest?.abort();
  valueRequest?.abort();
  if (prefixTimer) clearTimeout(prefixTimer);
});
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="kv-keys"
      v-model:open="sidebarOpen"
      v-model:collapsed="sidebarCollapsed"
      :default-size="21"
      :collapsed-size="4"
      :min-size="17"
      :max-size="28"
      :menu="{ title: 'KV keys', description: 'Browse configured KV stores.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'border-t border-default px-3 py-2' }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <div class="flex h-10 w-full min-w-0 items-center gap-2.5 px-1.5">
          <ConsoleMark />
          <span v-if="!collapsed" class="grid min-w-0 flex-1 leading-none">
            <small class="truncate text-[10px] font-bold uppercase tracking-[.12em] text-muted">
              ViteHub Console
            </small>
            <strong class="mt-1 truncate text-sm font-semibold text-highlighted">KV</strong>
          </span>
        </div>
      </template>

      <template #default="{ collapsed }">
        <div class="px-2 pt-2">
          <ConsoleBackButton :collapsed="collapsed" />
        </div>
        <div v-if="!collapsed" class="flex items-end justify-between px-4 pb-3 pt-5">
          <div>
            <span class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">KV storage</span>
            <h1 class="mt-1 text-lg font-semibold tracking-tight text-highlighted">Keys</h1>
          </div>
          <span class="text-xs text-muted">{{ total }}</span>
        </div>
        <div class="px-2 pb-3" :class="collapsed ? 'pt-2' : ''">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="w-full bg-transparent ring-default"
            label="Search console"
          />
        </div>
        <div v-if="!collapsed" class="grid gap-2 px-3 pb-3">
          <USelect
            v-if="stores.length > 1"
            v-model="selectedStore"
            :items="storeItems"
            aria-label="KV store"
            size="sm"
          />
          <UInput
            v-model="prefix"
            aria-label="Filter keys by prefix"
            icon="i-lucide-search"
            placeholder="Filter by prefix"
            size="sm"
          />
        </div>
        <div v-if="!collapsed && errorMessage(listError)" class="px-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Could not load keys"
            :description="errorMessage(listError)"
            :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: refresh }]"
          />
        </div>
        <div v-if="collapsed" class="min-h-0 flex-1 overflow-y-auto">
          <div class="grid gap-1 px-2 py-1">
            <UTooltip v-for="key in keys" :key="key" :text="key" :content="{ side: 'right' }">
              <UButton
                icon="i-lucide-key-round"
                color="neutral"
                :variant="selectedKey === key ? 'soft' : 'ghost'"
                block
                :aria-label="key"
                @click="selectKey(key)"
              />
            </UTooltip>
          </div>
        </div>
        <div v-else-if="listLoading && !keys.length" class="grid gap-2 px-3">
          <USkeleton v-for="index in 6" :key="index" class="h-10 rounded-md" />
        </div>
        <nav v-else-if="keys.length" class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="KV keys">
          <button
            v-for="key in keys"
            :key="key"
            type="button"
            class="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-start text-sm outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary"
            :class="selectedKey === key ? 'bg-elevated text-highlighted' : 'text-toned'"
            @click="selectKey(key)"
          >
            <UIcon name="i-lucide-key-round" class="size-3.5 shrink-0 text-dimmed" />
            <span class="truncate font-mono text-xs">{{ key }}</span>
          </button>
          <p v-if="listTruncated" class="px-2 pt-3 text-xs leading-5 text-muted">
            Showing the first {{ keys.length }} of {{ total }} keys. Narrow the prefix to inspect more.
          </p>
        </nav>
        <UEmpty
          v-else-if="!listLoading && !listError && !collapsed"
          class="min-h-0 flex-1 px-4"
          icon="i-lucide-key-round"
          :title="prefix ? 'No matching keys' : 'This store is empty'"
          :description="prefix ? 'Try a shorter key prefix.' : 'Keys will appear here when the application writes them.'"
        />
      </template>

      <template #footer="{ collapsed, collapse }">
        <span v-if="!collapsed" class="flex items-center gap-1.5 text-xs text-muted">
          <UIcon name="i-lucide-lock-keyhole" class="size-3.5" />Read-only
        </span>
        <UTooltip text="Refresh keys">
          <UButton
            aria-label="Refresh keys"
            color="neutral"
            icon="i-lucide-refresh-cw"
            size="xs"
            variant="ghost"
            :loading="listLoading || valueLoading"
            @click="refresh"
          />
        </UTooltip>
        <UButton
          class="max-lg:hidden"
          :class="collapsed ? '' : 'ml-1'"
          :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="collapsed ? 'Show KV keys' : 'Hide KV keys'"
          @click="collapse(!collapsed)"
        />
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agents-base="agentsBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="kv-value">
      <div class="flex min-h-0 flex-1 flex-col" aria-live="polite">
        <header class="flex h-14 shrink-0 items-center border-b border-default px-4">
          <UButton
            class="mr-2 lg:hidden"
            aria-label="Open KV keys"
            color="neutral"
            icon="i-lucide-panel-left"
            variant="ghost"
            @click="sidebarOpen = true"
          />
          <div class="min-w-0">
            <p class="truncate font-mono text-xs font-medium text-highlighted">
              {{ selectedKey || "KV" }}
            </p>
            <p v-if="selectedKey" class="mt-0.5 truncate text-[11px] text-muted">{{ selectedStore }}</p>
          </div>
          <UBadge class="ml-auto" color="neutral" label="Read-only" size="sm" variant="soft" />
        </header>

        <UEmpty
          v-if="!selectedKey && !listLoading"
          class="min-h-0 flex-1"
          icon="i-lucide-mouse-pointer-click"
          title="Select a key"
          description="Choose a key from the sidebar to inspect its stored value."
        />
        <div v-else-if="valueLoading && !selectedValue" class="flex min-h-0 flex-1 items-center justify-center">
          <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" />
        </div>
        <UEmpty
          v-else-if="errorMessage(valueError)"
          class="min-h-0 flex-1"
          icon="i-lucide-cloud-off"
          title="Could not load this value"
          :description="errorMessage(valueError)"
          :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: () => loadValue() }]"
        />
        <UEmpty
          v-else-if="selectedValue && !selectedValue.found"
          class="min-h-0 flex-1"
          icon="i-lucide-key-round"
          title="Key no longer exists"
          description="Refresh the key list to load the current store contents."
        />
        <main v-else-if="selectedValue" class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div class="mx-auto w-full max-w-5xl">
            <dl class="grid gap-px overflow-hidden rounded-lg border border-default bg-default sm:grid-cols-3">
              <div class="min-w-0 bg-muted/30 px-4 py-3">
                <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">Store</dt>
                <dd class="mt-1 truncate font-mono text-xs text-highlighted">{{ selectedValue.store }}</dd>
              </div>
              <div class="min-w-0 border-t border-default bg-muted/30 px-4 py-3 sm:border-l sm:border-t-0">
                <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">Type</dt>
                <dd class="mt-1 truncate font-mono text-xs text-highlighted">{{ selectedValue.type }}</dd>
              </div>
              <div class="min-w-0 border-t border-default bg-muted/30 px-4 py-3 sm:border-l sm:border-t-0">
                <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">Format</dt>
                <dd class="mt-1 truncate font-mono text-xs text-highlighted">{{ selectedValue.format }}</dd>
              </div>
            </dl>

            <section class="mt-4 overflow-hidden rounded-lg border border-default bg-default">
              <div class="flex h-10 items-center border-b border-default px-3">
                <h2 class="text-xs font-medium text-highlighted">Value</h2>
                <UBadge
                  v-if="selectedValue.truncated"
                  class="ml-auto"
                  color="warning"
                  label="Truncated at 256 KiB"
                  size="sm"
                  variant="soft"
                />
              </div>
              <pre class="min-h-56 overflow-auto p-4 font-mono text-xs leading-5 text-toned"><code>{{ selectedValue.value }}</code></pre>
            </section>
          </div>
        </main>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
