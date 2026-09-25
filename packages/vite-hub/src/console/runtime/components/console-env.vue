<script setup lang="ts">
import type { TableColumn, TableRow } from "@nuxt/ui";
import type { ServerEnvDescriptionEntry } from "@vite-hub/env";
import * as v from "valibot";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { requestConsole } from "../client/request";
import { rememberConsoleSection } from "../sections";
import ConsoleBrand from "./console-brand.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleEnvDetails from "./console-env-details.vue";

const descriptionSchema = v.object({
  entries: v.array(
    v.object({
      path: v.optional(v.string()),
      source: v.picklist(["env", "literal", "provider"]),
      provider: v.optional(v.string()),
      secret: v.boolean(),
      required: v.boolean(),
      hasDefault: v.boolean(),
    }),
  ),
});
const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  envBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const sidebarOpen = ref(false);
const entries = ref<readonly ServerEnvDescriptionEntry[]>([]);
const search = ref("");
const source = ref("all");
const selected = ref<ServerEnvDescriptionEntry>();
const loading = ref(true);
const failed = ref(false);
let request: AbortController | undefined;
const detailOpen = computed({
  get: () => Boolean(selected.value),
  set: (open: boolean) => {
    if (!open) selected.value = undefined;
  },
});
const sourceLabel = (entry: ServerEnvDescriptionEntry) =>
  entry.source === "env"
    ? "Host environment"
    : entry.source === "literal"
      ? "Application config"
      : entry.provider || "External provider";
const sourceItems = computed(() => [
  { label: "All sources", value: "all" },
  ...Array.from(new Set(entries.value.map(sourceLabel)))
    .sort()
    .map((label) => ({ label, value: label })),
]);
const rows = computed(() =>
  entries.value.filter(
    (entry) =>
      (source.value === "all" || sourceLabel(entry) === source.value) &&
      `${entry.path ?? ""} ${sourceLabel(entry)}`
        .toLowerCase()
        .includes(search.value.trim().toLowerCase()),
  ),
);
const columns: TableColumn<ServerEnvDescriptionEntry>[] = [
  { accessorKey: "path", header: "Variable" },
  { id: "source", header: "Source" },
  { id: "value", header: "Value" },
];
function selectRow(_event: Event, row: TableRow<ServerEnvDescriptionEntry>) {
  selected.value = row.original;
}
async function refresh() {
  request?.abort();
  const current = new AbortController();
  request = current;
  loading.value = true;
  failed.value = false;
  try {
    const result = v.parse(
      descriptionSchema,
      await requestConsole(props.envBase, { signal: current.signal }),
    );
    if (current.signal.aborted) return;
    entries.value = result.entries;
    if (!sourceItems.value.some((item) => item.value === source.value)) source.value = "all";
    selected.value = selected.value
      ? entries.value.find((entry) => entry.path === selected.value?.path)
      : undefined;
  } catch {
    if (!current.signal.aborted) failed.value = true;
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}
onMounted(() => {
  rememberConsoleSection("env");
  void refresh();
});
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="console-navigation"
      v-model:open="sidebarOpen"
      :default-size="16"
      :min-size="13"
      :max-size="26"
      :menu="{ title: 'Env', description: 'Server environment.' }"
      :ui="{
        body: 'gap-0 overflow-hidden p-0',
        footer: 'h-11 shrink-0 border-t border-default px-2 py-1.5',
      }"
      resizable
    >
      <template #header="{ collapsed }"
        ><ConsoleBrand :collapsed="collapsed" :sections-base="sectionsBase"
      /></template>
      <template #default="{ collapsed }">
        <div class="flex shrink-0 items-center gap-1 px-[0.875rem] pb-2 pt-1">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="vitehub-console__search min-w-0 flex-1 rounded-md border border-default bg-transparent px-2 ring-0 hover:bg-elevated/60"
            label="Search console"
          />
        </div>
      </template>
      <template #footer="{ collapsed }"
        ><ConsolePrimitiveSwitcher
          active="env"
          :collapsed="collapsed"
          :sections-base="sectionsBase"
      /></template>
    </UDashboardSidebar>
    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />
    <UDashboardPanel id="env" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <template #header>
        <UDashboardNavbar title="Env" :toggle="{ 'aria-label': 'Open sidebar' }">
          <template #right>
            <UTooltip text="Refresh declarations"
              ><UButton
                aria-label="Refresh declarations"
                color="neutral"
                icon="i-ph-arrows-clockwise-light"
                size="xs"
                variant="ghost"
                :disabled="loading"
                @click="refresh"
            /></UTooltip>
          </template>
        </UDashboardNavbar>
        <div class="flex flex-wrap items-center gap-2 border-b border-default px-4 py-2">
          <UInput
            v-model="search"
            aria-label="Search variables"
            placeholder="Search variables…"
            icon="i-ph-magnifying-glass-light"
            variant="none"
            class="min-w-40 flex-1"
          />
          <USelect
            v-if="sourceItems.length > 2"
            v-model="source"
            :items="sourceItems"
            aria-label="Filter by source"
            variant="ghost"
            class="w-44"
          />
        </div>
      </template>
      <template #body>
        <main class="min-h-0 flex-1 overflow-auto">
          <div v-if="failed" role="alert" class="flex items-center gap-3 p-4 text-sm">
            <span>Could not load environment declarations.</span
            ><UButton label="Try again" color="neutral" variant="ghost" @click="refresh" />
          </div>
          <p v-else-if="loading" role="status" class="p-4 text-sm text-muted">
            Loading environment…
          </p>
          <UTable
            v-else
            :data="rows"
            :columns="columns"
            :on-select="selectRow"
            :empty="entries.length ? 'No matching variables.' : 'No Server Env variables declared.'"
            :ui="{
              tr: 'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
            }"
          >
            <template #path-cell="{ row }"
              ><span class="font-mono text-xs text-highlighted">{{
                row.original.path?.replace(/^env\.server\./, "") || "Undisclosed name"
              }}</span></template
            >
            <template #source-cell="{ row }"
              ><span class="text-xs text-muted">{{ sourceLabel(row.original) }}</span></template
            >
            <template #value-cell="{ row }"
              ><span class="text-xs text-muted">{{
                row.original.secret ? "Secret" : "Server only"
              }}</span></template
            >
          </UTable>
        </main>
      </template>
    </UDashboardPanel>
    <USlideover
      v-model:open="detailOpen"
      :title="selected?.path?.replace(/^env\.server\./, '') || 'Variable'"
      description="Declaration details"
      :ui="{ description: 'sr-only' }"
    >
      <template #body><ConsoleEnvDetails v-if="selected" :entry="selected" /></template>
    </USlideover>
  </ConsoleFrame>
</template>
