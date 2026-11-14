<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { ConsoleContributedSection, ConsoleOperationView } from "../definitions";
import { Status } from "@vite-hub/ui";

import { loadOperationItems, operationCell, operationLink, operationStatus, operationSwitchCall, operationTime, operationValue } from "../client/operation-view";
import { isConsoleSectionReadOnly } from "../client/read-only";
import { requestConsoleOperation } from "../client/request";
import { useConsoleToast } from "../client/toast";
import { querySelection, queryText, useConsoleQuery } from "../client/route-query";
import ConsoleCodeText from "./console-code-text.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";

// The thread panel brings the comment parts of `@vite-hub/ui`, so it loads when a section asks for it.
const ConsoleCommentThread = defineAsyncComponent(() => import("./console-comment-thread.vue"));
const ConsoleCommentOnSite = defineAsyncComponent(() => import("./console-comment-on-site.vue"));

/**
 * A section that lists the result of an operation. The call runs over the Console RPC as the signed-in Console user, so
 * the operation checks access for each item and the list holds only what that user may read.
 */
const props = defineProps<{
  definitionsBase: string;
  details: ConsoleContributedSection;
  sectionsBase: string;
}>();

// The rail's Search button and Cmd+K open the search of the page. Its API routes sit next to the sections route.
const apiBase = props.sectionsBase.replace(/\/sections$/, "");
const view = computed(() => props.details.view as ConsoleOperationView);
// The filter and the search live in the URL, so a reload or a shared link opens the same list. The first filter is the
// default.
// `thread` is the item open in the side panel, so Back closes it and a link opens it.
const { filter: filterId, q: search, thread: selectedId } = useConsoleQuery({ filter: querySelection({ history: "replace" }), q: queryText(), thread: querySelection() });
const items = ref<Array<Record<string, unknown>>>([]);
const loading = ref(true);
const error = ref<unknown>();
let controller: AbortController | undefined;

const filters = computed(() => view.value.filters ?? []);
const filterItems = computed(() => filters.value.map((filter) => ({ label: filter.label, value: filter.id })));
const activeFilter = computed(() => filters.value.find((filter) => filter.id === filterId.value) ?? filters.value[0]);
/** Match full column values and their displayed text, such as the page, the author, or the comment. */
const visibleItems = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return items.value;
  return items.value.filter(item => view.value.columns.some(column => {
    const value = String(operationValue(item, column.key) ?? "").toLowerCase();
    return value.includes(query)
      || value.replaceAll(/\s+/g, " ").includes(query)
      || operationCell(item, column).toLowerCase().includes(query);
  }));
});

async function load(): Promise<void> {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    const result = await loadOperationItems(view.value, { ...activeFilter.value?.input }, current.signal);
    if (controller !== current) return;
    items.value = result;
    error.value = undefined;
  } catch (cause) {
    if (current.signal.aborted) return;
    items.value = [];
    error.value = cause;
  } finally {
    if (controller === current) loading.value = false;
  }
}

// A `switch` column flips a value with its operation. The row stays disabled until the list loads again.
const toast = useConsoleToast();
const readOnly = ref(false);
const switching = ref(new Set<string>());
async function flip(item: Record<string, unknown>, column: ConsoleOperationView["columns"][number], checked: boolean): Promise<void> {
  const call = operationSwitchCall(item, column, checked);
  const id = itemId(item);
  if (!call || switching.value.has(id)) return;
  switching.value = new Set([...switching.value, id]);
  try {
    await requestConsoleOperation(call.operation, call.input);
    await load();
  } catch {
    toast.error(`Couldn't change ${column.label.toLowerCase()}. Try again.`);
  } finally {
    const next = new Set(switching.value);
    next.delete(id);
    switching.value = next;
  }
}

const detail = computed(() => view.value.detail);
// The row button holds the text of the item, such as the comment, so a screen reader names what it opens.
const openColumn = computed(() => view.value.columns.find(column => column.format === "excerpt") ?? view.value.columns[0]);
const itemId = (item: Record<string, unknown>) => String(operationValue(item, "id"));
const threadPanel = ref<{ canClose: () => boolean } | null>(null);
const selectedItem = computed(() => items.value.find(item => itemId(item) === selectedId.value));

// Query refs update before router guards run, so check drafts before changing the panel's id.
function selectThread(id: string): void {
  if (id === selectedId.value || threadPanel.value?.canClose() === false) return;
  selectedId.value = id;
}

// Comment on site can open a page that has threads. The list already holds them, so this needs no other request.
const threadPages = computed(() => detail.value?.kind === "comment-thread"
  ? items.value.flatMap(item => operationValue(item, "subject.kind") === "page" ? [String(operationValue(item, "subject.id"))] : [])
  : []);

/** Reload through the operation so its filters, ordering, and pagination still apply after a mutation. */
function refreshItems(): void {
  void load();
}

function choose(id: string): void {
  filterId.value = id === filters.value[0]?.id ? undefined : id;
}

onMounted(() => {
  void load();
  if (view.value.columns.some(column => column.format === "switch")) void isConsoleSectionReadOnly(props.sectionsBase, props.details.id).then((value) => { readOnly.value = value; });
});
watch(() => activeFilter.value?.id, () => void load());
onBeforeUnmount(() => controller?.abort());
</script>

<template>
    <ConsoleSearch :agents-base="`${apiBase}/agents`" :definitions-base="definitionsBase" :kv-base="`${apiBase}/kv`" :search-base="`${apiBase}/search`" :sections-base="sectionsBase" />
    <UDashboardPanel :id="`console-${details.id}`">
      <template #header>
        <ConsolePageHeader :title="details.label" :toggle="false">
          <template #right>
            <UTooltip text="Refresh">
              <UButton aria-label="Refresh" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :loading="loading" @click="load" />
            </UTooltip>
            <ConsoleCommentOnSite v-if="detail?.kind === 'comment-thread'" :pages="threadPages" size="xs" />
          </template>
        </ConsolePageHeader>
        <ConsolePageToolbar>
          <template v-if="filters.length" #tabs>
            <UTabs
              :model-value="activeFilter?.id"
              :items="filterItems"
              :content="false"
              class="w-max"
              aria-label="Filter"
              @update:model-value="choose(String($event))"
            />
          </template>
          <UInput
            v-model="search"
            class="w-full sm:w-56"
            icon="i-lucide-search"
            :placeholder="`Filter ${details.label.toLowerCase()}…`"
            :aria-label="`Filter ${details.label}`"
          />
        </ConsolePageToolbar>
      </template>
      <template #body>
        <div class="flex flex-1 flex-col p-4">
          <ConsoleState v-if="error" :error="error" title="Couldn't load the list" :retry="load" />
          <div v-else-if="loading && !items.length">
            <USkeleton v-for="index in 5" :key="index" class="my-1 h-9 rounded-md" />
          </div>
          <ConsoleState v-else-if="!items.length" :section="details.id" title="Nothing here yet" description="No item matches this filter." />
          <UEmpty
            v-else-if="!visibleItems.length"
            variant="naked"
            class="flex-1 py-12"
            icon="i-lucide-search"
            title="No matching items"
            :description="`Nothing matches “${search.trim()}”.`"
            :actions="[{ label: 'Clear search', color: 'neutral', variant: 'outline', onClick: () => { search = '' } }]"
          />
          <!-- A phone scrolls the table sideways instead of wrapping every cell to one word per line. -->
          <div v-else class="-mx-4 overflow-x-auto px-4">
            <table class="w-full min-w-xl text-left text-sm">
              <thead class="text-xs text-muted">
                <tr>
                  <th v-for="column in view.columns" :key="column.key" class="px-2 py-1.5 font-medium">{{ column.label }}</th>
                  <th v-if="view.link" class="w-10 px-2 py-1.5"><span class="sr-only">{{ view.link.label ?? "Open" }}</span></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="item in visibleItems"
                  :key="itemId(item)"
                  class="border-t border-default"
                  :class="detail ? 'relative hover:bg-elevated' : undefined"
                >
                  <td
                    v-for="column in view.columns"
                    :key="column.key"
                    class="px-2 py-2 align-top"
                    :class="{ 'whitespace-nowrap text-muted tabular-nums': column.format === 'datetime', 'whitespace-nowrap': column.format === 'status' }"
                  >
                    <!-- The button overlay makes the whole row open the item. The theme rings the button itself. -->
                    <button
                      v-if="detail && column === openColumn"
                      type="button"
                      class="rounded-md text-left after:absolute after:inset-0"
                      @click="selectThread(itemId(item))"
                    >{{ operationCell(item, column) }}</button>
                    <!-- Above the row button, so a flip does not open the item. The first column names the row. -->
                    <USwitch
                      v-else-if="column.format === 'switch'"
                      class="relative"
                      size="sm"
                      :model-value="operationValue(item, column.key) === true"
                      :disabled="readOnly || switching.has(itemId(item))"
                      :aria-label="`${column.label}: ${operationCell(item, view.columns[0] ?? column)}`"
                      @update:model-value="flip(item, column, $event === true)"
                    />
                    <template v-else-if="column.format === 'status' && operationStatus(item, column)">
                      <Status :tone="operationStatus(item, column)!.tone" :label="operationStatus(item, column)!.label" />
                    </template>
                    <!-- Above the row button, so the tooltip with the exact time opens on hover. -->
                    <span v-else-if="column.format === 'datetime' && operationTime(item, column)" class="relative"><ConsoleRelativeTime :value="operationTime(item, column)!" /></span>
                    <template v-else>{{ operationCell(item, column) }}</template>
                  </td>
                  <td v-if="view.link" class="px-2 py-1 text-right align-top">
                    <!-- Above the row button, so the link still opens the page. One icon keeps the row on one line. -->
                    <UTooltip v-if="operationLink(item, view)" :text="view.link.label ?? 'Open'">
                      <UButton
                        class="relative"
                        icon="i-lucide-external-link"
                        color="neutral"
                        variant="ghost"
                        size="sm"
                        :aria-label="view.link.label ?? 'Open'"
                        :href="operationLink(item, view)"
                        external
                        target="_blank"
                        rel="noreferrer"
                      />
                    </UTooltip>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <!-- The notice sits at the bottom of the pane while the list loads and when it is short, so it does not move. -->
          <p class="mt-auto pt-4 text-xs text-muted"><ConsoleCodeText :text="view.notice" /></p>
        </div>
      </template>
    </UDashboardPanel>
    <ConsoleCommentThread
      ref="threadPanel"
      v-if="detail?.kind === 'comment-thread'"
      :id="selectedId"
      :initial="selectedItem"
      :view="view"
      @changed="refreshItems"
      @close="selectedId = undefined"
      @removed="refreshItems"
    />
</template>
