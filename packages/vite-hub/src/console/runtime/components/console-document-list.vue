<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  consoleDocumentStateColor,
  consoleDocumentStateLabel,
  consoleErrorMessage,
  consoleFieldIssues,
  consoleInvalidDocument,
  consolePublishMismatches,
  describeConsoleSchemaFields,
} from "../client/documents";
import { recentTimestamp } from "../client/time";

import type { ConsoleDocumentCollection, ConsoleDocumentPage, ConsoleDocumentPublishExpectation, ConsoleDocumentsClient, ConsoleDocumentState, ConsoleDocumentSummary } from "../client/documents";

const props = defineProps<{
  changes: number;
  client: ConsoleDocumentsClient;
  collection: ConsoleDocumentCollection;
}>();

const emit = defineEmits<{ changed: [] }>();

const route = useRoute();
const router = useRouter();
const search = ref(String(route.query.q ?? ""));
const state = ref<ConsoleDocumentState | "all">("all");
const filters = ref<Record<string, string>>({});
const items = ref<ConsoleDocumentSummary[]>([]);
const page = ref<ConsoleDocumentPage>();
const loading = ref(false);
const loadingMore = ref(false);
const error = ref<unknown>();
const selected = ref<Set<string>>(new Set());
const publishing = ref(false);
const publishOpen = ref(false);
const notice = ref<{ color: "error" | "success", text: string }>();
/** Why the last publish published nothing: drafts that moved after the list loaded, or a draft that no longer validates. */
const publishProblem = ref<{ actions: Array<{ label: string, onClick: () => void }>, color: "error" | "warning", description: string, title: string }>();
const loadedAt = ref(Date.now());
let request = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const fields = computed(() => describeConsoleSchemaFields(props.collection.schema));
// Fields with a small set of values become filters.
const facetFields = computed(() => fields.value.filter(field => field.kind === "enum" || field.kind === "boolean" || field.kind === "string-list").slice(0, 3));
const dateField = computed(() => fields.value.find(field => field.kind === "date" || field.kind === "date-time"));
const tagField = computed(() => fields.value.find(field => field.kind === "string-list" || field.kind === "enum"));
const sortOptions = computed(() => [
  ...(dateField.value ? [{ label: `${dateField.value.label}, newest`, value: `${dateField.value.name}:desc` }, { label: `${dateField.value.label}, oldest`, value: `${dateField.value.name}:asc` }] : []),
  ...(props.collection.titleField ? [{ label: "Title A–Z", value: `${props.collection.titleField}:asc` }] : []),
  { label: "Id A–Z", value: "id:asc" },
]);
const sort = ref(sortOptions.value[0]!.value);

const states = computed(() => page.value?.states ?? { changed: 0, deleted: 0, draft: 0, published: 0 });
const total = computed(() => states.value.draft + states.value.changed + states.value.published);
const pendingChanges = computed(() => page.value?.changes.length ?? 0);
const stateTabs = computed(() => [
  { label: "All", value: "all", badge: total.value },
  { label: "Drafts", value: "draft", badge: states.value.draft },
  { label: "Changed", value: "changed", badge: states.value.changed },
  { label: "Published", value: "published", badge: states.value.published },
  ...(states.value.deleted ? [{ label: "Deleted", value: "deleted", badge: states.value.deleted }] : []),
]);
const selectedPublishable = computed<ConsoleDocumentPublishExpectation[]>(() => items.value
  .filter(item => selected.value.has(item.id) && item.state !== "published")
  .map(item => ({ digest: item.digest, id: item.id })));
const activeFilterCount = computed(() => Object.keys(activeFilters()).length);
const filtered = computed(() => Boolean(search.value.trim()) || state.value !== "all" || Object.values(filters.value).some(value => value && value !== "*"));

// Facet values come from the last load without field filters, so choosing one value keeps the others available.
const facetOptions = ref<NonNullable<ConsoleDocumentPage["facets"]>>({});
const anyValue = "*";

function facetItems(name: string, label: string) {
  const values = facetOptions.value[name] ?? [];
  return [{ label: `Any ${label.toLowerCase()}`, value: anyValue }, ...values.map(entry => ({ label: `${entry.value} (${entry.count})`, value: entry.value }))];
}

function activeFilters(): Record<string, string> {
  return Object.fromEntries(Object.entries(filters.value).filter(([, value]) => value && value !== anyValue));
}

async function load(append = false): Promise<void> {
  const current = ++request;
  if (append) loadingMore.value = true;
  else loading.value = true;
  const [field, direction] = sort.value.split(":");
  try {
    const result = await props.client.list(props.collection.name, {
      cursor: append ? page.value?.nextCursor ?? undefined : undefined,
      facets: facetFields.value.map(entry => entry.name),
      filter: activeFilters(),
      limit: 50,
      search: search.value.trim() || undefined,
      sort: { direction: direction === "desc" ? "desc" : "asc", field: field! },
      state: state.value === "all" ? undefined : state.value,
    });
    if (current !== request) return;
    items.value = append ? [...items.value, ...result.items] : result.items;
    if (!append && !Object.keys(activeFilters()).length && result.facets) facetOptions.value = result.facets;
    page.value = append ? { ...result, facets: page.value?.facets ?? result.facets, states: result.states } : result;
    loadedAt.value = Date.now();
    error.value = undefined;
    if (!append) selected.value = new Set();
  }
  catch (requestError) {
    if (current === request) error.value = requestError;
  }
  finally {
    if (current === request) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function open(item: Pick<ConsoleDocumentSummary, "id">): void {
  void router.push({ name: route.name ?? undefined, params: { collection: props.collection.name, document: item.id.split("/") }, query: {} });
}

function create(): void {
  void router.push({ name: route.name ?? undefined, params: { collection: props.collection.name, document: [] }, query: { new: "1" } });
}

function toggle(id: string, value: boolean | "indeterminate"): void {
  const next = new Set(selected.value);
  if (value === true) next.add(id);
  else next.delete(id);
  selected.value = next;
}

const allSelected = computed<boolean | "indeterminate">(() => {
  if (!items.value.length || !selected.value.size) return false;
  return items.value.every(item => selected.value.has(item.id)) ? true : "indeterminate";
});

function toggleAll(value: boolean | "indeterminate"): void {
  selected.value = value === true ? new Set(items.value.map(item => item.id)) : new Set();
}

function documentTitle(id: string): string {
  return items.value.find(item => item.id === id)?.title ?? id;
}

function refreshAfterPublishProblem(): void {
  publishProblem.value = undefined;
  void load();
}

/** Publishes exactly the drafts this list showed: every change, or the selected documents. */
async function publish(expect: readonly ConsoleDocumentPublishExpectation[] = page.value?.changes ?? []): Promise<void> {
  if (!expect.length) return;
  publishing.value = true;
  notice.value = undefined;
  publishProblem.value = undefined;
  try {
    const result = await props.client.publish(props.collection.name, expect);
    const count = result.documents.length;
    notice.value = { color: "success", text: count ? `Published ${count} ${count === 1 ? "change" : "changes"}.` : "Nothing to publish." };
    publishOpen.value = false;
    emit("changed");
  }
  catch (publishError) {
    publishOpen.value = false;
    const moved = consolePublishMismatches(publishError);
    const invalid = consoleInvalidDocument(publishError);
    if (moved) {
      const names = moved.map(entry => `${documentTitle(entry.id)}${entry.actual === null ? " (deleted)" : ""}`).join(", ");
      publishProblem.value = {
        actions: [{ label: "Refresh", onClick: refreshAfterPublishProblem }],
        color: "warning",
        description: `Nothing was published. ${names} changed after this list loaded. Refresh to review the latest drafts, then publish again.`,
        title: moved.length === 1 ? "1 document changed since you reviewed it" : `${moved.length} documents changed since you reviewed them`,
      };
    }
    else if (invalid) {
      const issues = consoleFieldIssues(publishError) ?? [];
      publishProblem.value = {
        actions: [{ label: `Open ${documentTitle(invalid)}`, onClick: () => open({ id: invalid }) }],
        color: "error",
        description: `Nothing was published. ${issues.map(issue => `${[issue.field, ...issue.path].filter(segment => segment !== undefined).join(".") || "Document"}: ${issue.message}`).join(" ")} Open it, fix the fields, and save before you publish.`,
        title: `${documentTitle(invalid)} no longer validates`,
      };
    }
    else notice.value = { color: "error", text: consoleErrorMessage(publishError, "Could not publish.") };
  }
  finally {
    publishing.value = false;
  }
}

function updatedLabel(value: string | null): string {
  return (value && recentTimestamp(value, loadedAt.value)) ?? "";
}

function updatedTitle(value: string | null): string {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Unknown";
}

function formatValue(value: unknown, kind?: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (kind === "date" || kind === "date-time") {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" });
  }
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void router.replace({ query: { ...route.query, q: search.value.trim() || undefined } });
    void load();
  }, 200);
});
watch([state, sort, filters], () => void load(), { deep: true });
watch(() => [props.collection.name, props.changes], () => void load(), { immediate: true });
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <UDashboardNavbar :ui="{ root: 'border-b border-default', right: 'gap-2' }" :toggle="{ 'aria-label': 'Open collections' }">
    <template #title>
      <span class="flex min-w-0 items-baseline gap-2">
        <span class="truncate text-sm font-semibold text-highlighted">{{ collection.label }}</span>
        <span class="truncate font-mono text-[11px] text-dimmed">{{ collection.path }}</span>
      </span>
    </template>
    <template #right>
      <UPopover v-if="collection.access.publish && pendingChanges" v-model:open="publishOpen">
        <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-send" :label="`Publish ${pendingChanges} ${pendingChanges === 1 ? 'change' : 'changes'}`" />
        <template #content>
          <div class="grid max-w-72 gap-3 p-3">
            <p class="text-xs text-muted">
              Copy every draft change of {{ collection.label }} to the published site:
              {{ [states.draft && `${states.draft} new`, states.changed && `${states.changed} changed`, states.deleted && `${states.deleted} deleted`].filter(Boolean).join(", ") }}.
            </p>
            <div class="flex justify-end gap-2">
              <UButton color="neutral" variant="ghost" size="sm" label="Cancel" @click="publishOpen = false" />
              <UButton size="sm" label="Publish all" :loading="publishing" @click="publish(page?.changes)" />
            </div>
          </div>
        </template>
      </UPopover>
      <UButton v-if="collection.access.write" size="sm" icon="i-lucide-plus" label="New" @click="create" />
    </template>
  </UDashboardNavbar>

  <div class="flex flex-wrap items-center gap-2 border-b border-default px-4 py-2.5">
    <UInput
      v-model="search"
      class="w-full sm:w-56"
      icon="i-lucide-search"
      size="sm"
      placeholder="Search"
      aria-label="Search documents"
    />
    <UTabs
      v-model="state"
      :items="stateTabs"
      :content="false"
      size="xs"
      variant="link"
      color="neutral"
      aria-label="Filter by state"
    />
    <div class="ms-auto flex items-center gap-2">
      <UPopover v-if="facetFields.length" :content="{ align: 'end' }">
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-list-filter"
          :label="activeFilterCount ? `Filters · ${activeFilterCount}` : 'Filters'"
        />
        <template #content>
          <div class="grid w-64 gap-3 p-3">
            <UFormField v-for="field in facetFields" :key="field.name" :label="field.label" :ui="{ label: 'text-xs' }">
              <USelect
                v-model="filters[field.name]"
                size="sm"
                class="w-full"
                :items="facetItems(field.name, field.label)"
                :placeholder="`Any ${field.label.toLowerCase()}`"
              />
            </UFormField>
            <UButton v-if="activeFilterCount" class="justify-self-start" color="neutral" variant="link" size="xs" label="Clear filters" @click="filters = {}" />
          </div>
        </template>
      </UPopover>
      <USelect v-model="sort" size="sm" class="w-40" :items="sortOptions" aria-label="Sort documents" />
    </div>
  </div>

  <div v-if="notice || selectedPublishable.length" class="flex items-center gap-3 border-b border-default px-4 py-2" role="status" aria-live="polite">
    <p v-if="notice" class="min-w-0 flex-1 truncate text-xs" :class="notice.color === 'error' ? 'text-error' : 'text-success'">{{ notice.text }}</p>
    <span v-else class="flex-1" />
    <UButton
      v-if="collection.access.publish && selectedPublishable.length"
      size="xs"
      icon="i-lucide-send"
      :loading="publishing"
      :label="`Publish ${selectedPublishable.length} selected`"
      @click="publish(selectedPublishable)"
    />
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <UAlert
      v-if="publishProblem"
      class="m-4"
      :color="publishProblem.color"
      variant="subtle"
      icon="i-lucide-circle-alert"
      role="alert"
      :title="publishProblem.title"
      :description="publishProblem.description"
      :actions="publishProblem.actions"
      close
      @update:open="publishProblem = undefined"
    />
    <UAlert
      v-if="error"
      class="m-4"
      color="error"
      variant="subtle"
      icon="i-ph-cloud-slash-light"
      title="Could not load documents"
      :description="consoleErrorMessage(error)"
      :actions="[{ label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: () => load() }]"
    />
    <div v-else-if="loading && !items.length" class="grid gap-2 p-4">
      <USkeleton v-for="index in 6" :key="index" class="h-10 rounded-md" />
    </div>
    <UEmpty
      v-else-if="!items.length"
      class="py-16"
      icon="i-lucide-file-text"
      :title="filtered ? 'No matching documents' : `No ${collection.label.toLowerCase()} yet`"
      :description="filtered ? 'Change the search or filters.' : collection.access.write ? 'Create the first document.' : 'Documents appear here when someone saves one.'"
      :actions="!filtered && collection.access.write ? [{ label: 'New document', icon: 'i-lucide-plus', onClick: create }] : []"
    />
    <table v-else class="w-full table-fixed text-left text-sm">
      <thead class="sticky top-0 z-10 border-b border-default bg-default text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th v-if="collection.access.publish" class="w-10 px-4 py-2 font-medium">
            <UCheckbox :model-value="allSelected" aria-label="Select every document on this page" @update:model-value="toggleAll" />
          </th>
          <th class="py-2 font-medium" :class="collection.access.publish ? 'px-2' : 'px-4'">Title</th>
          <th class="w-28 px-2 py-2 font-medium">State</th>
          <th v-if="dateField" class="hidden w-36 px-2 py-2 font-medium md:table-cell">{{ dateField.label }}</th>
          <th class="hidden w-24 px-2 py-2 font-medium sm:table-cell">Updated</th>
          <th v-if="tagField" class="hidden w-48 px-2 py-2 font-medium lg:table-cell">{{ tagField.label }}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-default">
        <tr
          v-for="item in items"
          :key="item.id"
          class="group cursor-pointer hover:bg-elevated/50"
          :class="{ 'bg-elevated/40': selected.has(item.id) }"
          @click="open(item)"
        >
          <td v-if="collection.access.publish" class="px-4 py-2.5" @click.stop>
            <UCheckbox :model-value="selected.has(item.id)" :aria-label="`Select ${item.title}`" @update:model-value="toggle(item.id, $event)" />
          </td>
          <td class="min-w-0 py-2.5" :class="collection.access.publish ? 'px-2' : 'px-4'">
            <a
              :href="router.resolve({ name: route.name ?? undefined, params: { collection: collection.name, document: item.id.split('/') } }).href"
              class="block min-w-0 focus-visible:outline-2 focus-visible:outline-primary"
              @click.prevent="open(item)"
            >
              <span class="block truncate font-medium text-highlighted" :class="{ 'line-through decoration-muted': item.state === 'deleted' }">{{ item.title }}</span>
              <span class="block truncate font-mono text-[11px] text-dimmed">{{ item.id }}</span>
            </a>
          </td>
          <td class="px-2 py-2.5">
            <UBadge :color="consoleDocumentStateColor(item.state)" variant="subtle" size="sm" :label="consoleDocumentStateLabel(item.state)" />
          </td>
          <td v-if="dateField" class="hidden truncate px-2 py-2.5 text-xs text-muted md:table-cell">{{ formatValue(item.data[dateField.name], dateField.kind) }}</td>
          <td class="hidden truncate px-2 py-2.5 text-xs text-muted sm:table-cell">
            <UTooltip v-if="item.updatedAt" :text="updatedTitle(item.updatedAt)">
              <time :datetime="item.updatedAt">{{ updatedLabel(item.updatedAt) }}</time>
            </UTooltip>
          </td>
          <td v-if="tagField" class="hidden truncate px-2 py-2.5 text-xs text-muted lg:table-cell">{{ formatValue(item.data[tagField.name]) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="page?.nextCursor" class="flex justify-center p-4">
      <UButton color="neutral" variant="outline" size="sm" label="Load more" :loading="loadingMore" @click="load(true)" />
    </div>
    <p v-if="items.length" class="px-4 pb-4 text-[11px] text-dimmed">{{ items.length }} of {{ page?.total ?? items.length }}</p>
  </div>
</template>
