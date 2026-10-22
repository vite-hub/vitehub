<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  consoleDocumentScheduleLabel,
  consoleDocumentScheduleTone,
  consoleDocumentStateColor,
  consoleDocumentStateLabel,
  consoleErrorMessage,
  consoleFieldIssues,
  consoleFixFieldsLabel,
  consoleInvalidDocument,
  consoleListQuery,
  consolePublishMismatches,
  describeConsoleSchemaFields,
  humanizeConsoleFieldIssues,
  parseConsoleListQuery,
  rememberConsoleListQuery,
  stableConsoleJSON,
} from "../client/documents";
import { useConsoleDocumentSessions } from "../client/presence";
import { useConsoleToast } from "../client/toast";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsolePresenceAvatars from "./console-presence-avatars.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleStatus from "./console-status.vue";

import type { ConsoleDocumentCollection, ConsoleDocumentPage, ConsoleDocumentPublishExpectation, ConsoleDocumentsClient, ConsoleDocumentSummary, ConsoleListState } from "../client/documents";

const props = defineProps<{
  changes: number;
  client: ConsoleDocumentsClient;
  collection: ConsoleDocumentCollection;
}>();

const emit = defineEmits<{ changed: [] }>();

const route = useRoute();
const router = useRouter();
const toast = useConsoleToast();
// Who has each document open, polled like the editor reports: 15 seconds while visible, 60 while hidden.
const { of: sessionsOf, user: sessionUser } = useConsoleDocumentSessions({ client: props.client, collection: props.collection.name });

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
const defaultSort = computed(() => sortOptions.value[0]!.value);

// The tab, search, sort, and filters live in the URL, so a reload or a shared link opens the same view.
function readView() {
  return parseConsoleListQuery(route.query, { facets: facetFields.value.map(field => field.name), sorts: sortOptions.value.map(option => option.value) });
}
const initial = readView();
const search = ref(initial.search);
const state = ref<ConsoleListState>(initial.state);
const sort = ref(initial.sort);
const filters = ref<Record<string, string>>(initial.filters);

const items = ref<ConsoleDocumentSummary[]>([]);
const page = ref<ConsoleDocumentPage>();
const loading = ref(false);
const loadingMore = ref(false);
const error = ref<unknown>();
const selected = ref<Set<string>>(new Set());
const publishing = ref(false);
const publishOpen = ref(false);
/** Why the last publish published nothing: drafts that moved after the list loaded, or a draft that no longer validates. */
const publishProblem = ref<{ actions: Array<{ label: string, color: "neutral", variant: "outline", onClick: () => void }>, color: "error" | "warning", description: string, title: string }>();
let request = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const states = computed(() => page.value?.states ?? { changed: 0, deleted: 0, draft: 0, published: 0 });
const total = computed(() => states.value.draft + states.value.changed + states.value.published);
// Drafts with field issues stay out of Publish all: they would make the whole publish fail.
const publishableChanges = computed(() => page.value?.changes.filter(change => !change.issues) ?? []);
const blockedChanges = computed(() => (page.value?.changes.length ?? 0) - publishableChanges.value.length);
const pendingChanges = computed(() => publishableChanges.value.length);
// Geist tabs: a count of zero shows no badge.
const stateTabs = computed(() => [
  { label: "All", value: "all", count: total.value },
  { label: "Drafts", value: "draft", count: states.value.draft },
  { label: "Changed", value: "changed", count: states.value.changed },
  { label: "Published", value: "published", count: states.value.published },
  ...(states.value.deleted || state.value === "deleted" ? [{ label: "Deleted", value: "deleted", count: states.value.deleted }] : []),
  ...(page.value?.scheduled || state.value === "scheduled" ? [{ label: "Scheduled", value: "scheduled", count: page.value?.scheduled ?? 0 }] : []),
].map(({ count, ...tab }) => (count ? { ...tab, badge: { class: "rounded-full tabular-nums", color: "neutral" as const, label: String(count), variant: "soft" as const } } : tab)));
const selectedPublishable = computed<ConsoleDocumentPublishExpectation[]>(() => items.value
  .filter(item => selected.value.has(item.id) && item.state !== "published")
  .map(item => ({ digest: item.digest, id: item.id })));
const activeFilters = computed(() => Object.entries(filters.value)
  .filter(([, value]) => value && value !== anyValue)
  .map(([name, value]) => ({ label: facetFields.value.find(field => field.name === name)?.label ?? name, name, value })));
// An empty state tab explains the state instead of blaming the filters.
const emptyState = computed(() => {
  const plural = props.collection.label.toLowerCase();
  if (search.value.trim()) return { action: true, description: `Nothing matches “${search.value.trim()}”${activeFilters.value.length || state.value !== "all" ? " with these filters" : ""}.`, title: "No matching documents" };
  if (activeFilters.value.length) return { action: true, description: "Nothing matches these filters.", title: "No matching documents" };
  if (state.value === "draft") return { action: false, description: `New ${plural} stay here until you publish them.`, title: "No drafts" };
  if (state.value === "changed") return { action: false, description: "Published documents with unpublished edits show here.", title: "No unpublished changes" };
  if (state.value === "deleted") return { action: false, description: "Documents deleted from the draft stay here until you publish the deletion.", title: "Nothing deleted" };
  if (state.value === "published") return { action: false, description: "Published documents are on the site.", title: "Nothing published yet" };
  if (state.value === "scheduled") return { action: false, description: "Schedule a publish from the arrow next to Publish on a document.", title: "Nothing scheduled" };
  return undefined;
});

// Facet values come from the last load without field filters, so choosing one value keeps the others available.
const facetOptions = ref<NonNullable<ConsoleDocumentPage["facets"]>>({});
const anyValue = "*";

function facetItems(name: string, label: string) {
  const values = facetOptions.value[name] ?? [];
  return [{ label: `Any ${label.toLowerCase()}`, value: anyValue }, ...values.map(entry => ({ label: `${entry.value} (${entry.count})`, value: entry.value }))];
}

function filterQuery(): Record<string, string> {
  return Object.fromEntries(activeFilters.value.map(filter => [filter.name, filter.value]));
}

function removeFilter(name: string): void {
  const next = { ...filters.value };
  delete next[name];
  filters.value = next;
}

function writeQuery(): void {
  const query = consoleListQuery({ filters: filterQuery(), search: search.value, sort: sort.value, state: state.value }, defaultSort.value);
  rememberConsoleListQuery(props.collection.name, query);
  if (stableConsoleJSON(query) === stableConsoleJSON(consoleListQuery(readView(), defaultSort.value))) return;
  void router.replace({ query });
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
      filter: filterQuery(),
      limit: 50,
      search: search.value.trim() || undefined,
      sort: { direction: direction === "desc" ? "desc" : "asc", field: field! },
      scheduled: state.value === "scheduled" || undefined,
      state: state.value === "all" || state.value === "scheduled" ? undefined : state.value,
    });
    if (current !== request) return;
    items.value = append ? [...items.value, ...result.items] : result.items;
    if (!append && !activeFilters.value.length && result.facets) facetOptions.value = result.facets;
    page.value = append ? { ...result, facets: page.value?.facets ?? result.facets, states: result.states } : result;
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

function documentRoute(item: Pick<ConsoleDocumentSummary, "id">) {
  return { name: route.name ?? undefined, params: { collection: props.collection.name, document: item.id.split("/") }, query: {} };
}

function open(item: Pick<ConsoleDocumentSummary, "id">): void {
  void router.push(documentRoute(item));
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

/**
 * Publishes exactly the drafts this list showed: every change, or the selected documents. Rows show Published at once
 * (deleted rows leave) and roll back if the request fails.
 */
async function publish(expect: readonly ConsoleDocumentPublishExpectation[] = publishableChanges.value): Promise<void> {
  if (publishing.value || !expect.length) return;
  const before = { items: items.value, page: page.value, selected: selected.value };
  const targets = new Set(expect.map(entry => entry.id));
  const counts = { ...states.value };
  items.value = items.value.flatMap((item) => {
    if (item.state === "published" || !targets.has(item.id)) return [item];
    counts[item.state]--;
    if (item.state === "deleted") return [];
    counts.published++;
    return [{ ...item, state: "published" as const }];
  });
  // Changes on other pages are not in `items`; their counts move too.
  for (const change of page.value?.changes ?? []) {
    if (!targets.has(change.id) || items.value.some(item => item.id === change.id) || before.items.some(item => item.id === change.id)) continue;
    counts[change.state]--;
    if (change.state !== "deleted") counts.published++;
  }
  if (page.value) page.value = { ...page.value, changes: page.value.changes.filter(change => !targets.has(change.id)), states: counts };
  selected.value = new Set();
  publishOpen.value = false;
  publishProblem.value = undefined;
  publishing.value = true;
  try {
    const result = await props.client.publish(props.collection.name, expect);
    const count = result.documents.length;
    if (count) toast.show({ title: count === 1 ? "Change published" : `${count} changes published` });
    emit("changed");
  }
  catch (publishError) {
    items.value = before.items;
    page.value = before.page;
    selected.value = before.selected;
    const moved = consolePublishMismatches(publishError);
    const invalid = consoleInvalidDocument(publishError);
    // A publish that stopped for a reason the reader must act on stays as a note above the list.
    if (moved) {
      const names = moved.map(entry => `${documentTitle(entry.id)}${entry.actual === null ? " (deleted)" : ""}`).join(", ");
      publishProblem.value = {
        actions: [{ color: "neutral", label: "Refresh", onClick: refreshAfterPublishProblem, variant: "outline" }],
        color: "warning",
        description: `Nothing was published. ${names} changed after this list loaded. Refresh to review the latest drafts, then publish again.`,
        title: moved.length === 1 ? "1 document changed since you reviewed it" : `${moved.length} documents changed since you reviewed them`,
      };
    }
    else if (invalid) {
      const issues = consoleFieldIssues(publishError) ?? [];
      publishProblem.value = {
        actions: [{ color: "neutral", label: `Open ${documentTitle(invalid)}`, onClick: () => open({ id: invalid }), variant: "outline" }],
        color: "error",
        description: `Nothing was published. ${humanizeConsoleFieldIssues(fields.value, issues).map(issue => issue.message).join(" ")} Open it, fix the fields, and save before you publish.`,
        title: `${documentTitle(invalid)} no longer validates`,
      };
    }
    else toast.error("Couldn't publish. Try again.", { label: "Retry", onClick: () => publish(expect) });
  }
  finally {
    publishing.value = false;
  }
}

function formatValue(value: unknown, kind?: string): string {
  if (value === undefined || value === null || value === "") return "—";
  if (kind === "date" || kind === "date-time") {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" });
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
}

watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    writeQuery();
    void load();
  }, 200);
});
watch([state, sort, filters], () => {
  writeQuery();
  void load();
}, { deep: true });
// Back and Forward change the query without this component; read the view from it again.
watch(() => route.query, () => {
  const view = readView();
  if (view.search !== search.value) search.value = view.search;
  if (view.state !== state.value) state.value = view.state;
  if (view.sort !== sort.value) sort.value = view.sort;
  if (stableConsoleJSON(view.filters) !== stableConsoleJSON(filterQuery())) filters.value = view.filters;
});
watch(() => [props.collection.name, props.changes], () => void load(), { immediate: true });
rememberConsoleListQuery(props.collection.name, consoleListQuery(initial, defaultSort.value));
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <ConsolePageHeader :title="collection.label" :description="collection.path">
    <template #right>
      <UPopover v-if="collection.access.publish && pendingChanges" v-model:open="publishOpen">
        <UButton variant="outline" size="sm" label="Publish" :aria-label="`Publish ${pendingChanges} ${pendingChanges === 1 ? 'change' : 'changes'}`">
          <template #trailing>
            <UBadge color="neutral" variant="soft" size="sm" class="rounded-full tabular-nums" :label="String(pendingChanges)" />
          </template>
        </UButton>
        <template #content>
          <div class="grid max-w-72 gap-3 p-3">
            <p class="text-[13px] text-muted">
              Copy every draft change of {{ collection.label }} to the published site:
              {{ [states.draft && `${states.draft} new`, states.changed && `${states.changed} changed`, states.deleted && `${states.deleted} deleted`].filter(Boolean).join(", ") }}.
              <template v-if="blockedChanges"> {{ blockedChanges === 1 ? "1 draft with field issues stays" : `${blockedChanges} drafts with field issues stay` }} unpublished.</template>
            </p>
            <div class="flex justify-end gap-2">
              <UButton variant="ghost" size="sm" label="Cancel" @click="publishOpen = false" />
              <UButton size="sm" label="Publish all" :loading="publishing" @click="publish(publishableChanges)" />
            </div>
          </div>
        </template>
      </UPopover>
      <UButton v-if="collection.access.write" size="sm" icon="i-lucide-plus" label="New" @click="create" />
    </template>
  </ConsolePageHeader>

  <ConsolePageToolbar>
    <UInput
      v-model="search"
      class="w-full sm:w-56"
      icon="i-lucide-search"
      size="sm"
      :placeholder="`Search ${collection.label.toLowerCase()}…`"
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
      :ui="{ trigger: 'text-[13px]' }"
    />
    <div v-if="activeFilters.length" class="flex flex-wrap items-center gap-1.5">
      <UButton
        v-for="filter in activeFilters"
        :key="filter.name"
        variant="soft"
        size="xs"
        trailing-icon="i-lucide-x"
        :label="`${filter.label}: ${filter.value}`"
        :aria-label="`Remove filter ${filter.label}: ${filter.value}`"
        @click="removeFilter(filter.name)"
      />
    </div>
    <div class="ms-auto flex items-center gap-2">
      <UPopover v-if="facetFields.length" :content="{ align: 'end' }">
        <UButton variant="outline" size="sm" icon="i-lucide-list-filter" label="Filter" />
        <template #content>
          <div class="grid w-64 gap-3 p-3">
            <UFormField v-for="field in facetFields" :key="field.name" :label="field.label" :ui="{ label: 'text-xs' }">
              <USelectMenu
                v-if="field.kind === 'string-list'"
                v-model="filters[field.name]"
                size="sm"
                class="w-full"
                value-key="value"
                :items="facetItems(field.name, field.label)"
                :placeholder="`Any ${field.label.toLowerCase()}`"
                :search-input="{ placeholder: `Search ${field.label.toLowerCase()}…` }"
              />
              <USelect
                v-else
                v-model="filters[field.name]"
                size="sm"
                class="w-full"
                :items="facetItems(field.name, field.label)"
                :placeholder="`Any ${field.label.toLowerCase()}`"
              />
            </UFormField>
            <UButton v-if="activeFilters.length" class="justify-self-start" variant="link" size="xs" label="Clear filters" @click="filters = {}" />
          </div>
        </template>
      </UPopover>
      <USelect v-model="sort" size="sm" class="w-40" :items="sortOptions" aria-label="Sort documents" />
    </div>
  </ConsolePageToolbar>

  <div v-if="collection.access.publish && selected.size" class="flex items-center gap-3 border-b border-default px-4 py-1.5">
    <p class="min-w-0 flex-1 text-[13px] text-muted tabular-nums">{{ selected.size }} selected</p>
    <UButton variant="ghost" size="xs" label="Clear" @click="selected = new Set()" />
    <UButton
      v-if="selectedPublishable.length"
      variant="outline"
      size="xs"
      :loading="publishing"
      :label="`Publish ${selectedPublishable.length}`"
      @click="publish(selectedPublishable)"
    />
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto" aria-live="polite" :aria-busy="loading">
    <UAlert
      v-if="publishProblem"
      class="m-4"
      :color="publishProblem.color"
      variant="outline"
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
      icon="i-lucide-cloud-off"
      :title="`Couldn't load ${collection.label.toLowerCase()}`"
      :description="consoleErrorMessage(error)"
      :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: () => load() }]"
    />
    <div v-else-if="loading && !items.length" class="grid gap-px p-4" aria-hidden="true">
      <USkeleton v-for="index in 6" :key="index" class="h-12 rounded-md" />
    </div>
    <UEmpty
      v-else-if="!items.length"
      class="m-4 py-12"
      icon="i-lucide-file-text"
      :title="emptyState?.title ?? `No ${collection.label.toLowerCase()} yet`"
      :description="emptyState?.description ?? (collection.access.write ? 'Create the first document.' : 'Documents appear here when someone saves one.')"
      :actions="emptyState ? (emptyState.action ? [{ label: 'Clear filters', color: 'neutral', variant: 'outline', onClick: () => { search = ''; state = 'all'; filters = {} } }] : []) : collection.access.write ? [{ label: 'New document', icon: 'i-lucide-plus', onClick: create }] : []"
    />
    <table v-else class="w-full table-fixed text-left">
      <thead class="sticky top-0 z-10 bg-default text-xs text-muted shadow-[inset_0_-1px_0_var(--ui-border)]">
        <tr class="h-9">
          <th v-if="collection.access.publish" class="w-10 ps-4 font-medium">
            <UCheckbox :model-value="allSelected" aria-label="Select every document on this page" @update:model-value="toggleAll" />
          </th>
          <th class="font-medium" :class="collection.access.publish ? 'px-2' : 'px-4'">Title</th>
          <th class="hidden px-2 font-medium sm:table-cell" :class="page?.scheduled ? 'w-56' : 'w-28'">State</th>
          <th v-if="tagField" class="hidden w-40 px-2 font-medium lg:table-cell">{{ tagField.label }}</th>
          <th v-if="dateField" class="hidden w-32 px-2 font-medium md:table-cell">{{ dateField.label }}</th>
          <th class="hidden w-28 pe-4 ps-2 text-right font-medium sm:table-cell">Updated</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-default">
        <tr
          v-for="item in items"
          :key="item.id"
          class="group h-12 cursor-pointer hover:bg-elevated/60"
          :class="{ 'bg-elevated/40': selected.has(item.id) }"
          @click="open(item)"
        >
          <td v-if="collection.access.publish" class="ps-4" @click.stop>
            <!-- Row checkboxes appear on hover, on focus, or once anything is selected (Linear, Gmail). -->
            <UCheckbox
              :class="selected.size ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100'"
              :model-value="selected.has(item.id)"
              :aria-label="`Select ${item.title}`"
              @update:model-value="toggle(item.id, $event)"
            />
          </td>
          <td class="min-w-0 py-2 sm:py-1" :class="collection.access.publish ? 'px-2' : 'px-4'">
            <a
              :href="router.resolve(documentRoute(item)).href"
              class="block min-w-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
              @click.prevent="open(item)"
            >
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-medium text-highlighted" :class="{ 'text-muted line-through decoration-(--ui-text-dimmed)': item.state === 'deleted' }">{{ item.title }}</span>
                <ConsolePresenceAvatars :sessions="sessionsOf(collection.name, item.id)" :user="sessionUser" variant="row" />
              </span>
              <span class="block truncate font-mono text-xs text-dimmed">{{ item.id }}</span>
            </a>
            <!-- On a phone the state follows the title instead of taking a column. -->
            <span class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 sm:hidden">
              <ConsoleStatus :tone="consoleDocumentStateColor(item.state)" :label="consoleDocumentStateLabel(item.state)" />
              <ConsoleStatus v-if="item.issues" tone="error" :label="item.issues === 1 ? '1 issue' : `${item.issues} issues`" />
              <ConsoleStatus v-if="item.schedule" :tone="consoleDocumentScheduleTone(item.schedule)" :label="consoleDocumentScheduleLabel(item.schedule)" />
            </span>
          </td>
          <td class="hidden px-2 sm:table-cell">
            <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
              <ConsoleStatus :tone="consoleDocumentStateColor(item.state)" :label="consoleDocumentStateLabel(item.state)" class="text-[13px]" />
              <UTooltip v-if="item.issues" :text="consoleFixFieldsLabel(item.issues)" :content="{ side: 'top' }">
                <ConsoleStatus tone="error" :label="item.issues === 1 ? '1 issue' : `${item.issues} issues`" class="text-[13px]" />
              </UTooltip>
              <UTooltip v-if="item.schedule" :text="item.schedule.failure ?? `Publishes the reviewed draft at ${new Date(item.schedule.at).toLocaleString()}`" :content="{ side: 'top' }">
                <ConsoleStatus :tone="consoleDocumentScheduleTone(item.schedule)" :label="consoleDocumentScheduleLabel(item.schedule)" class="text-[13px]" />
              </UTooltip>
            </span>
          </td>
          <td v-if="tagField" class="hidden truncate px-2 text-[13px] text-muted lg:table-cell">{{ formatValue(item.data[tagField.name]) }}</td>
          <td v-if="dateField" class="hidden truncate px-2 text-[13px] tabular-nums text-muted md:table-cell">{{ formatValue(item.data[dateField.name], dateField.kind) }}</td>
          <td class="hidden truncate pe-4 ps-2 text-right text-[13px] text-muted sm:table-cell">
            <ConsoleRelativeTime v-if="item.updatedAt" :value="item.updatedAt" />
            <span v-else>—</span>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="page?.nextCursor" class="flex justify-center p-4">
      <UButton variant="outline" size="sm" label="Load more" :loading="loadingMore" @click="load(true)" />
    </div>
    <p v-if="items.length" class="flex flex-wrap gap-x-3 px-4 py-3 text-xs text-dimmed">
      <span class="tabular-nums">{{ items.length }} of {{ page?.total ?? items.length }}</span>
      <span v-if="state === 'draft'">Drafts aren't on the site until you publish them.</span>
      <span v-else-if="state === 'deleted'">Deleted documents stay on the site until you publish the deletion.</span>
    </p>
  </div>
</template>
