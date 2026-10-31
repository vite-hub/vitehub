<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type { ConsoleContributedSection, ConsoleOperationView } from "../definitions";
import { loadOperationItems, operationCell, operationLink, operationValue } from "../client/operation-view";
import ConsoleFrame from "./console-frame.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";

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
const filterId = ref<string>();
const items = ref<Array<Record<string, unknown>>>([]);
const loading = ref(true);
const error = ref<unknown>();
let controller: AbortController | undefined;

const filters = computed(() => view.value.filters ?? []);
const activeFilter = computed(() => filters.value.find((filter) => filter.id === filterId.value) ?? filters.value[0]);

async function load(): Promise<void> {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    const result = await loadOperationItems(props.definitionsBase, view.value, { ...activeFilter.value?.input }, current.signal);
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

function choose(id: string): void {
  filterId.value = id;
  void load();
}

onMounted(() => void load());
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <ConsoleFrame :active="details.id" :sections-base="sectionsBase">
    <ConsoleSearch :agents-base="`${apiBase}/agents`" :definitions-base="definitionsBase" :kv-base="`${apiBase}/kv`" :search-base="`${apiBase}/search`" :sections-base="sectionsBase" />
    <UDashboardPanel :id="`console-${details.id}`" :ui="{ body: 'min-h-0 gap-0 overflow-auto p-0' }">
      <template #header>
        <ConsolePageHeader :title="details.label" :description="details.description" :toggle="false">
          <template #right>
            <UTooltip text="Refresh">
              <UButton aria-label="Refresh" icon="i-lucide-refresh-cw" size="xs" variant="ghost" color="neutral" :loading="loading" @click="load" />
            </UTooltip>
          </template>
        </ConsolePageHeader>
        <div v-if="filters.length" class="flex flex-wrap items-center gap-1.5 border-b border-default px-4 py-2" role="group" aria-label="Filter">
          <UButton
            v-for="filter in filters"
            :key="filter.id"
            size="xs"
            :color="activeFilter?.id === filter.id ? 'primary' : 'neutral'"
            :variant="activeFilter?.id === filter.id ? 'soft' : 'ghost'"
            :aria-pressed="activeFilter?.id === filter.id"
            :label="filter.label"
            @click="choose(filter.id)"
          />
        </div>
      </template>
      <template #body>
        <div class="p-4">
          <ConsoleState v-if="error" :error="error" title="Couldn't load the list" :retry="load" />
          <template v-else-if="loading && !items.length">
            <USkeleton v-for="index in 5" :key="index" class="my-1 h-9 rounded-md" />
          </template>
          <ConsoleState v-else-if="!items.length" :section="details.id" title="Nothing here yet" description="No item matches this filter." />
          <table v-else class="w-full text-left text-sm">
            <thead class="text-xs text-muted">
              <tr>
                <th v-for="column in view.columns" :key="column.key" class="px-2 py-1.5 font-medium">{{ column.label }}</th>
                <th v-if="view.link" class="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in items" :key="String(operationValue(item, 'id'))" class="border-t border-default">
                <td v-for="column in view.columns" :key="column.key" class="px-2 py-2 align-top">{{ operationCell(item, column) }}</td>
                <td v-if="view.link" class="px-2 py-2 text-right">
                  <a v-if="operationLink(item, view)" class="text-primary hover:underline" :href="operationLink(item, view)">{{ view.link.label ?? "Open" }}</a>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="mt-4 text-xs text-muted">{{ view.notice }}</p>
        </div>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
