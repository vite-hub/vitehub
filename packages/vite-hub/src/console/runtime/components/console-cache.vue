<script setup lang="ts">
import { Status } from "@vite-hub/ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { ConsoleRequestError, requestConsoleOperation } from "../client/request";
import { queryText, useConsoleQuery } from "../client/route-query";
import { useConsoleToast } from "../client/toast";
import { isConsoleSectionReadOnly } from "../client/read-only";
import { consoleBytes, consoleDuration } from "../client/format";
import { rememberConsoleSection } from "../sections";
import ConsoleConfirm from "./console-confirm.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";

interface CacheEntry {
  expired: boolean;
  expires?: string;
  group: string;
  key: string;
  mtime?: string;
  name: string;
  size: number;
}

interface CacheValue {
  entry?: CacheEntry;
  found: boolean;
  key: string;
  truncated?: boolean;
  value?: string;
}

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const toast = useConsoleToast();
// The prefix and the open key live in the URL, so a reload or a shared link opens the same view.
// Back and Forward change the URL without the controls, so the entries load again.
const { key: selectedKey, prefix } = useConsoleQuery({ key: queryText({ history: "replace" }), prefix: queryText({ history: "replace" }) }, {
  onRestore: () => {
    prefixDraft.value = prefix.value;
    void loadEntries();
  },
});
const entries = ref<CacheEntry[]>([]);
const nextCursor = ref<string>();
const selected = ref<CacheValue>();
const listLoading = ref(true);
const valueLoading = ref(false);
const listError = ref<unknown>();
const valueError = ref<unknown>();
/** A `cache:read` grant reads the cache, so the page offers no invalidation. */
const readOnly = ref(false);
const removeTarget = ref<{ key: string } | { prefix: string }>();
const removing = ref(false);
let listRequest: AbortController | undefined;
let valueRequest: AbortController | undefined;
const prefixDraft = ref(prefix.value);

const entryCount = computed(() => `${entries.value.length}${nextCursor.value ? "+" : ""} ${entries.value.length === 1 && !nextCursor.value ? "entry" : "entries"}`);
const removeOpen = computed({
  get: () => removeTarget.value !== undefined,
  set: (open: boolean) => { if (!open) removeTarget.value = undefined; },
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function parseEntry(value: unknown): CacheEntry | undefined {
  const source = record(value);
  if (!source || typeof source.key !== "string") return undefined;
  return {
    expired: source.expired === true,
    ...(typeof source.expires === "string" ? { expires: source.expires } : {}),
    group: typeof source.group === "string" ? source.group : "",
    key: source.key,
    ...(typeof source.mtime === "string" ? { mtime: source.mtime } : {}),
    name: typeof source.name === "string" ? source.name : "",
    size: typeof source.size === "number" ? source.size : Number.NaN,
  };
}

function invalid(what: string): ConsoleRequestError {
  return new ConsoleRequestError(502, `The Console returned an invalid cache ${what}.`);
}

/** A complete JSON value shows indented. A cut value stays as it came. */
const readableValue = computed(() => {
  const value = selected.value?.value;
  if (value === undefined || selected.value?.truncated) return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
});

/** `in 4m 10s` for a future expiry. An expired entry shows a status instead. */
function expiresIn(iso: string): string | undefined {
  const left = consoleDuration(Date.parse(iso) - Date.now(), { wholeSeconds: true });
  return left ? `in ${left}` : undefined;
}

function aborted(error: unknown): boolean {
  return error instanceof Object && "name" in error && error.name === "AbortError";
}

async function loadValue(key = selectedKey.value): Promise<void> {
  valueRequest?.abort();
  selected.value = undefined;
  valueError.value = undefined;
  if (!key) return;
  const controller = new AbortController();
  valueRequest = controller;
  valueLoading.value = true;
  try {
    const source = record(await requestConsoleOperation("cache.get", { key }, { signal: controller.signal }));
    if (!source || typeof source.key !== "string") throw invalid("entry");
    const entry = parseEntry(source.entry);
    if (valueRequest !== controller) return;
    selected.value = {
      ...(entry ? { entry } : {}),
      found: source.found === true,
      key: source.key,
      ...(source.truncated === true ? { truncated: true } : {}),
      ...(typeof source.value === "string" ? { value: source.value } : {}),
    };
  } catch (error) {
    if (!aborted(error) && valueRequest === controller) valueError.value = error;
  } finally {
    if (valueRequest === controller) {
      valueRequest = undefined;
      valueLoading.value = false;
    }
  }
}

async function loadEntries(options: { append?: boolean } = {}): Promise<void> {
  listRequest?.abort();
  const controller = new AbortController();
  listRequest = controller;
  listLoading.value = true;
  try {
    const source = record(await requestConsoleOperation("cache.list", {
      ...(options.append && nextCursor.value ? { cursor: nextCursor.value } : {}),
      ...(prefix.value ? { prefix: prefix.value } : {}),
    }, { signal: controller.signal }));
    if (!source || !Array.isArray(source.entries)) throw invalid("list");
    if (listRequest !== controller) return;
    const page = source.entries.flatMap(entry => parseEntry(entry) ?? []);
    entries.value = options.append ? [...entries.value, ...page] : page;
    nextCursor.value = typeof source.cursor === "string" ? source.cursor : undefined;
    listError.value = undefined;
    if (!options.append) {
      if (!selectedKey.value || !entries.value.some(entry => entry.key === selectedKey.value)) selectedKey.value = entries.value[0]?.key ?? "";
      await loadValue();
    }
  } catch (error) {
    if (!aborted(error) && listRequest === controller) listError.value = error;
  } finally {
    if (listRequest === controller) {
      listRequest = undefined;
      listLoading.value = false;
    }
  }
}

async function selectEntry(key: string): Promise<void> {
  selectedKey.value = key;
  await loadValue(key);
}

async function applyPrefix(): Promise<void> {
  prefix.value = prefixDraft.value.trim();
  selectedKey.value = "";
  await loadEntries();
}

async function confirmRemove(): Promise<void> {
  const target = removeTarget.value;
  if (!target || removing.value) return;
  removing.value = true;
  try {
    const result = record(await requestConsoleOperation("cache.delete", target));
    const deleted = typeof result?.deleted === "number" ? result.deleted : 0;
    removeTarget.value = undefined;
    toast.show({ title: "key" in target ? "Entry invalidated" : `${deleted} ${deleted === 1 ? "entry" : "entries"} invalidated${result?.more ? ". Run it again for the rest" : ""}` });
    if ("key" in target) selectedKey.value = "";
    await loadEntries();
  } catch (error) {
    removeTarget.value = undefined;
    toast.error(error instanceof Error ? error.message : "The Console could not invalidate the cache.");
  } finally {
    removing.value = false;
  }
}

onMounted(() => {
  void isConsoleSectionReadOnly(props.sectionsBase, "cache").then((value) => { readOnly.value = value; });
  rememberConsoleSection("cache");
  void loadEntries();
});

onBeforeUnmount(() => {
  listRequest?.abort();
  valueRequest?.abort();
});
</script>

<template>
    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="cache-entry">
      <ConsolePageHeader title="Cache" :toggle="false">
        <template #right>
          <UTooltip text="Refresh entries">
            <UButton aria-label="Refresh entries" icon="i-lucide-refresh-cw" variant="ghost" :loading="listLoading || valueLoading" @click="loadEntries()" />
          </UTooltip>
        </template>
      </ConsolePageHeader>
      <ConsolePageToolbar>
        <form class="flex w-full items-center gap-2 sm:w-auto" @submit.prevent="applyPrefix">
          <UInput v-model="prefixDraft" class="w-full font-mono sm:w-72" icon="i-lucide-search" placeholder="Key prefix, such as nitrofunctions" aria-label="Key prefix" />
        </form>
        <UButton
          v-if="prefix && entries.length && !readOnly"
          color="error"
          icon="i-lucide-trash-2"
          label="Invalidate prefix"
          variant="ghost"
          @click="removeTarget = { prefix }"
        />
        <span class="ms-auto text-xs text-muted tabular-nums" aria-live="polite">{{ entryCount }}</span>
      </ConsolePageToolbar>

      <ConsoleState v-if="listError" :error="listError" title="Could not load the cache" :retry="() => loadEntries()" />
      <div v-else class="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav class="flex max-h-[40vh] min-h-0 shrink-0 flex-col overflow-y-auto border-b border-default p-2 md:max-h-none md:w-80 md:border-r md:border-b-0" aria-label="Entries">
          <template v-if="listLoading && !entries.length">
            <USkeleton v-for="index in 8" :key="index" class="my-0.5 h-10 rounded-md" />
          </template>
          <template v-else-if="entries.length">
            <button
              v-for="entry in entries"
              :key="entry.key"
              type="button"
              class="vitehub-console__section-link is-detailed shrink-0"
              :aria-current="entry.key === selectedKey ? 'true' : undefined"
              :title="entry.key"
              @click="selectEntry(entry.key)"
            >
              <span class="grid min-w-0 flex-1 text-start">
                <span class="flex min-w-0 items-baseline gap-1.5">
                  <span class="truncate">{{ entry.name || entry.key }}</span>
                  <span v-if="entry.group" class="shrink-0 text-xs font-normal text-dimmed">{{ entry.group }}</span>
                  <span v-if="entry.expired" class="shrink-0 text-xs font-normal text-warning">Expired</span>
                </span>
                <span class="truncate font-mono text-xs font-normal text-dimmed">{{ entry.key }}</span>
              </span>
              <span class="shrink-0 self-start pt-px text-xs font-normal text-dimmed tabular-nums">{{ consoleBytes(entry.size) }}</span>
            </button>
            <UButton v-if="nextCursor" class="mt-1 self-start" label="Load more" variant="ghost" :loading="listLoading" @click="loadEntries({ append: true })" />
          </template>
          <UEmpty
            v-else
            variant="naked"
            size="xs"
            icon="i-vitehub-cache"
            :title="prefix ? `No entries start with “${prefix}”` : 'The cache is empty'"
            :description="prefix ? 'Clear the prefix to see every entry.' : 'Entries show here when a cached function or handler runs.'"
          />
        </nav>

        <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Entry">
          <div v-if="valueLoading && !selected" class="grid gap-2 p-4" aria-busy="true">
            <USkeleton class="h-4 w-56" />
            <USkeleton v-for="index in 6" :key="index" class="h-3.5" :class="index % 2 ? 'w-2/3' : 'w-1/2'" />
          </div>
          <ConsoleState v-else-if="valueError" :error="valueError" title="Could not load this entry" :retry="() => loadValue()" />
          <UEmpty
            v-else-if="selected && !selected.found"
            variant="naked"
            class="flex-1 py-16"
            icon="i-vitehub-cache"
            title="This entry no longer exists"
            description="It expired or was invalidated after the list loaded."
            :actions="[{ label: 'Refresh', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: () => loadEntries() }]"
          />
          <template v-else-if="selected?.entry">
            <header class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-default px-4 py-2">
              <h2 class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-highlighted" :title="selected.key">{{ selected.key }}</h2>
              <Status v-if="selected.entry.expired" tone="warning" label="Expired" />
              <Status v-if="selected.truncated" tone="warning" label="Truncated at 256 KB" />
              <UTooltip :text="readOnly ? 'This access can only read the cache' : 'Invalidate entry'">
                <UButton aria-label="Invalidate entry" color="error" icon="i-lucide-trash-2" variant="ghost" :disabled="readOnly" @click="removeTarget = { key: selected.key }" />
              </UTooltip>
            </header>
            <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-b border-default px-4 py-3 text-xs">
              <dt class="text-muted">Group</dt>
              <dd class="text-highlighted">{{ selected.entry.group || "Unknown" }}</dd>
              <dt class="text-muted">Name</dt>
              <dd class="font-mono text-highlighted">{{ selected.entry.name || "Unknown" }}</dd>
              <dt class="text-muted">Size</dt>
              <dd class="text-highlighted tabular-nums">{{ consoleBytes(selected.entry.size) }}</dd>
              <dt class="text-muted">Computed</dt>
              <dd class="text-highlighted"><ConsoleRelativeTime v-if="selected.entry.mtime" :value="selected.entry.mtime" /><span v-else>Unknown</span></dd>
              <dt class="text-muted">Expires</dt>
              <dd class="text-highlighted tabular-nums">
                <template v-if="!selected.entry.expires">No expiry</template>
                <ConsoleRelativeTime v-else-if="selected.entry.expired" :value="selected.entry.expires" />
                <span v-else :title="selected.entry.expires">{{ expiresIn(selected.entry.expires) }}</span>
              </dd>
            </dl>
            <pre class="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-5 text-toned"><code>{{ readableValue }}</code></pre>
          </template>
          <UEmpty
            v-else-if="!listLoading && entries.length"
            variant="naked"
            class="flex-1 py-16"
            icon="i-vitehub-cache"
            title="No entry selected"
            description="Choose an entry to see its value."
          />
        </section>
      </div>
    </UDashboardPanel>

    <ConsoleConfirm
      v-model:open="removeOpen"
      :title="removeTarget && 'prefix' in removeTarget ? 'Invalidate every entry under this prefix?' : 'Invalidate this entry?'"
      confirm-label="Invalidate"
      destructive
      :loading="removing"
      @confirm="confirmRemove"
    >
      <p v-if="removeTarget && 'prefix' in removeTarget">
        Every entry whose key starts with <span class="font-mono text-xs text-highlighted">{{ removeTarget.prefix }}</span> is removed, at most 1,000 at a time. The app computes each value again on its next call.
      </p>
      <p v-else-if="removeTarget">
        <span class="font-mono text-xs text-highlighted">{{ removeTarget.key }}</span> is removed. The app computes the value again on its next call.
      </p>
    </ConsoleConfirm>
</template>
