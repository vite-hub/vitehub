<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleDatabaseRelationship, ConsoleDatabaseTable } from "./console-database-model";
import { requestConsole } from "../client/request";
import { resolveConsoleRouteName } from "../console-route";
import { rememberConsoleSection } from "../sections";
import { consoleDatabaseRequestQuery, parseConsoleDatabase } from "./console-database-model";
import ConsoleFrame from "./console-frame.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleSearch from "./console-search.vue";

interface SchemaLine {
  id: string;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

const props = defineProps<{
  agentsBase: string;
  databaseBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
  view: "data" | "schema";
}>();

const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const filter = ref("");
const appliedSearch = ref("");
const sort = ref("");
const direction = ref<"asc" | "desc">("asc");
const offset = ref(0);
const database = ref<ReturnType<typeof parseConsoleDatabase>>();
const loading = ref(true);
const error = ref<unknown>();
let request: AbortController | undefined;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
const defaultSort = "__vitehub_default__";

const dataRouteName = "vitehub-console-databases";
const schemaRouteName = "vitehub-console-databases-schema";
const routeDatabase = computed(() =>
  Array.isArray(route.params.database) ? route.params.database[0] : route.params.database,
);
const routeTable = computed(() => {
  const value = Array.isArray(route.params.table) ? route.params.table[0] : route.params.table;
  return value;
});
const selectedTable = computed(
  () =>
    database.value?.tables.find((table) => table.name === database.value?.table) ??
    database.value?.tables.find((table) => table.name === routeTable.value) ??
    database.value?.tables[0],
);
const columns = computed<TableColumn<Record<string, string>>[]>(() =>
  (selectedTable.value?.columns ?? []).map((column) => ({
    accessorKey: column.key,
    header: column.name,
  })),
);
const tableRows = computed(() =>
  (database.value?.rows ?? []).map((row) =>
    Object.fromEntries(
      (selectedTable.value?.columns ?? []).map((column) => {
        const cell = row[column.key];
        return [column.key, cell ? `${cell.value}${cell.truncated ? "…" : ""}` : "NULL"];
      }),
    ),
  ),
);
const databaseItems = computed(() =>
  (database.value?.databases ?? []).map((name) => ({ label: name, value: name })),
);
const sortItems = computed(() => [
  { label: "Default order", value: defaultSort },
  ...(selectedTable.value?.columns ?? []).map((column) => ({
    label: column.name,
    value: column.key,
  })),
]);
const pageStart = computed(() => (database.value?.total ? database.value.offset + 1 : 0));
const pageEnd = computed(() =>
  database.value
    ? Math.min(database.value.offset + database.value.rows.length, database.value.total)
    : 0,
);
const canGoBack = computed(() => (database.value?.offset ?? 0) > 0);
const canGoForward = computed(() =>
  database.value
    ? database.value.offset + database.value.rows.length < database.value.total
    : false,
);
const schemaSize = computed(() => {
  const tables = database.value?.tables ?? [];
  return {
    height: Math.max(640, ...tables.map((table) => table.position.y + tableHeight(table) + 32)),
    width: Math.max(1000, ...tables.map((table) => table.position.x + 312)),
  };
});
const schemaLines = computed<SchemaLine[]>(() =>
  (database.value?.relationships ?? []).flatMap((relationship) => {
    const from = endpointPosition(relationship, "from");
    const to = endpointPosition(relationship, "to");
    return from && to
      ? [
          {
            id: `${relationship.from.table}.${relationship.from.column}-${relationship.to.table}.${relationship.to.column}`,
            x1: from.x,
            x2: to.x,
            y1: from.y,
            y2: to.y,
          },
        ]
      : [];
  }),
);

function tableHeight(table: ConsoleDatabaseTable): number {
  return 42 + table.columns.length * 25;
}

function endpointPosition(
  relationship: ConsoleDatabaseRelationship,
  side: "from" | "to",
): { x: number; y: number } | undefined {
  const endpoint = relationship[side];
  const table = database.value?.tables.find((entry) => entry.name === endpoint.table);
  if (!table) return;
  const column = table.columns.findIndex((entry) => entry.name === endpoint.column);
  if (column < 0) return;
  const otherTable = database.value?.tables.find(
    (entry) => entry.name === relationship[side === "from" ? "to" : "from"].table,
  );
  const pointsRight = table.position.x < (otherTable?.position.x ?? table.position.x);
  return {
    x: table.position.x + (pointsRight ? 280 : 0),
    y: table.position.y + 54 + column * 25,
  };
}

function errorMessage(value: unknown): string | undefined {
  return value instanceof Error
    ? value.message
    : value
      ? "The Console could not load this database."
      : undefined;
}

function routeParams(databaseName: string, table?: string): Record<string, string | undefined> {
  return { database: databaseName, table };
}

function resetTableState(): void {
  if (filterTimer) {
    clearTimeout(filterTimer);
    filterTimer = undefined;
  }
  filter.value = "";
  appliedSearch.value = "";
  sort.value = "";
  direction.value = "asc";
  offset.value = 0;
}

async function loadDatabase(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  try {
    const value = parseConsoleDatabase(
      await requestConsole(props.databaseBase, {
        query: consoleDatabaseRequestQuery({
          database: routeDatabase.value,
          direction: direction.value,
          offset: offset.value,
          search: appliedSearch.value,
          sort: sort.value,
          table: routeTable.value,
          view: props.view,
        }),
        signal: controller.signal,
      }),
    );
    if (request !== controller) return;
    database.value = value;
    error.value = undefined;
    if (props.view === "data") {
      const table = value.table ?? value.tables[0]?.name;
      if (table && (routeDatabase.value !== value.database || routeTable.value !== table)) {
        await router.replace({
          name: resolveConsoleRouteName(route.name, dataRouteName),
          params: routeParams(value.database, table),
        });
      }
    } else if (routeDatabase.value !== value.database) {
      await router.replace({
        name: resolveConsoleRouteName(route.name, schemaRouteName),
        params: { database: value.database },
      });
    }
  } catch (requestError) {
    if (
      requestError instanceof Object &&
      "name" in requestError &&
      requestError.name === "AbortError"
    )
      return;
    if (request === controller) error.value = requestError;
  } finally {
    if (request === controller) {
      request = undefined;
      loading.value = false;
    }
  }
}

async function openTable(name: string, replace = false): Promise<void> {
  const databaseName = database.value?.database ?? routeDatabase.value;
  if (!databaseName) return;
  sidebarOpen.value = false;
  if (props.view === "data" && routeDatabase.value === databaseName && routeTable.value === name) return;
  resetTableState();
  const location = {
    name: resolveConsoleRouteName(route.name, dataRouteName),
    params: routeParams(databaseName, name),
  };
  await (replace ? router.replace(location) : router.push(location));
}

async function openDatabase(value: unknown): Promise<void> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- USelect emits unknown values and database route names must be strings.
  if (typeof value !== "string" || value === database.value?.database) return;
  sidebarOpen.value = false;
  resetTableState();
  await router.push({
    name: resolveConsoleRouteName(route.name, dataRouteName),
    params: routeParams(value),
  });
}

async function openSchema(): Promise<void> {
  const databaseName = database.value?.database ?? routeDatabase.value;
  if (!databaseName) return;
  sidebarOpen.value = false;
  resetTableState();
  await router.push({
    name: resolveConsoleRouteName(route.name, schemaRouteName),
    params: { database: databaseName },
  });
}

function applyFilter(): void {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    const value = filter.value.trim();
    if (value === appliedSearch.value) return;
    appliedSearch.value = value;
    offset.value = 0;
    void loadDatabase();
  }, 250);
}

function setSort(value: unknown): void {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- USelect emits unknown values and column sort keys must be strings.
  if (typeof value !== "string") return;
  const nextSort = value === defaultSort ? "" : value;
  if (nextSort === sort.value) return;
  sort.value = nextSort;
  offset.value = 0;
  void loadDatabase();
}

function toggleDirection(): void {
  direction.value = direction.value === "asc" ? "desc" : "asc";
  offset.value = 0;
  void loadDatabase();
}

function movePage(delta: -1 | 1): void {
  if (!database.value) return;
  offset.value = Math.max(0, offset.value + delta * database.value.limit);
  void loadDatabase();
}

onMounted(() => {
  rememberConsoleSection("databases");
  void loadDatabase();
});
watch(filter, applyFilter);
watch(
  () => [route.params.database, route.params.table, props.view],
  () => {
    resetTableState();
    void loadDatabase();
  },
);
onBeforeUnmount(() => {
  request?.abort();
  if (filterTimer) clearTimeout(filterTimer);
});
</script>

<template>
  <ConsoleFrame active="databases" :sections-base="sectionsBase">
    <UDashboardSidebar
      id="console-navigation"
      class="vitehub-console__nav"
      v-model:open="sidebarOpen"
      :default-size="16"
      :collapsed-size="4"
      :min-size="13"
      :max-size="26"
      :menu="{ title: 'Database', description: 'Inspect tables and relationships.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0' }"
      resizable
    >
      <template #header="{ collapsed }">
        <div v-if="!collapsed" class="vitehub-console__panel-title">
          <span class="min-w-0 flex-1 truncate">Database</span>
          <UTooltip text="Refresh">
            <UButton aria-label="Refresh database" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :loading="loading" @click="loadDatabase" />
          </UTooltip>
        </div>
      </template>

      <template #default="{ collapsed }">
        <div v-if="!collapsed && database && database.databases.length > 1" class="px-2 pb-2">
          <USelect
            :model-value="database.database"
            :items="databaseItems"
            class="w-full"
            aria-label="Database"
            size="sm"
            @update:model-value="openDatabase"
          />
        </div>
        <nav class="vitehub-console__section-nav" :class="{ 'is-collapsed': collapsed }" aria-label="Database tables">
          <template v-if="loading && !database">
            <USkeleton v-for="index in 5" :key="index" class="my-0.5 h-8 rounded-md" />
          </template>
          <template v-else-if="database">
            <p v-if="!collapsed" class="vitehub-console__section-heading">Tables</p>
            <UTooltip v-for="table in database.tables" :key="table.name" :text="table.name" :disabled="!collapsed" :content="{ side: 'right' }">
              <button
                type="button"
                class="vitehub-console__section-link"
                :aria-current="view === 'data' && selectedTable?.name === table.name ? 'page' : undefined"
                :aria-label="collapsed ? table.name : undefined"
                @click="openTable(table.name)"
              >
                <UIcon name="i-lucide-table" class="vitehub-console__section-icon" aria-hidden="true" />
                <span v-if="!collapsed" class="min-w-0 flex-1 truncate text-start font-mono text-xs">{{ table.name }}</span>
              </button>
            </UTooltip>
            <p v-if="!collapsed && !database.tables.length" class="px-2 py-1.5 text-xs text-muted">This database has no tables yet.</p>
          </template>
        </nav>
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="database-inspector" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <ConsolePageHeader
        :title="view === 'schema' ? 'Schema' : selectedTable?.name || 'Database'"
        :description="database?.database"
      >
        <template #right>
          <span class="hidden text-xs text-dimmed sm:inline">Read-only</span>
          <div class="flex rounded-md ring-1 ring-(--ui-border) ring-inset" role="group" aria-label="View">
            <UTooltip text="Table data">
              <UButton size="sm" variant="ghost" icon="i-lucide-table" aria-label="Table data" :aria-pressed="view === 'data'" :class="view === 'data' ? 'bg-elevated text-highlighted' : 'text-dimmed'" @click="selectedTable && openTable(selectedTable.name)" />
            </UTooltip>
            <UTooltip text="Schema diagram">
              <UButton size="sm" variant="ghost" icon="i-lucide-share-2" aria-label="Schema diagram" :aria-pressed="view === 'schema'" :class="view === 'schema' ? 'bg-elevated text-highlighted' : 'text-dimmed'" @click="openSchema" />
            </UTooltip>
          </div>
        </template>
      </ConsolePageHeader>

      <UAlert
        v-if="errorMessage(error)"
        class="m-4"
        color="error"
        variant="subtle"
        icon="i-lucide-cloud-off"
        title="Couldn't load the database"
        :description="errorMessage(error)"
        :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: loadDatabase }]"
      />
      <div v-else-if="loading && !database" class="grid content-start gap-2 p-4" aria-busy="true">
        <USkeleton class="h-8 w-64" />
        <USkeleton v-for="index in 8" :key="index" class="h-9 w-full" />
      </div>

      <main
        v-else-if="database && view === 'data' && selectedTable"
        class="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <ConsolePageToolbar>
          <UInput
            v-model="filter"
            class="w-full sm:w-64"
            icon="i-lucide-search"
            size="sm"
            :placeholder="`Filter ${selectedTable.name}…`"
            aria-label="Filter rows"
          />
          <div class="ms-auto flex items-center gap-1.5">
            <USelect
              :model-value="sort || defaultSort"
              :items="sortItems"
              class="w-40"
              aria-label="Sort column"
              size="sm"
              @update:model-value="setSort"
            />
            <UTooltip :text="direction === 'asc' ? 'Ascending' : 'Descending'">
              <UButton
                :aria-label="direction === 'asc' ? 'Sort ascending' : 'Sort descending'"
                :icon="direction === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow'"
                size="sm"
                variant="ghost"
                @click="toggleDirection"
              />
            </UTooltip>
          </div>
        </ConsolePageToolbar>

        <div class="min-h-0 flex-1 overflow-auto">
          <UTable
            :columns="columns"
            :data="tableRows"
            :loading="loading"
            sticky="header"
            :ui="{
              base: 'min-w-max',
              th: 'whitespace-nowrap border-r border-default font-mono last:border-r-0',
              td: 'max-w-72 truncate whitespace-nowrap border-r border-default font-mono text-xs last:border-r-0',
              tr: 'border-b border-default hover:bg-elevated/50',
              empty: 'py-12 text-[13px] text-muted',
            }"
          >
            <template #empty>
              {{ appliedSearch ? `No rows match “${appliedSearch}”.` : "This table has no rows yet." }}
            </template>
          </UTable>
        </div>
        <footer class="flex h-10 shrink-0 items-center gap-3 border-t border-default px-4 text-xs text-muted tabular-nums">
          <span>{{ pageStart }}–{{ pageEnd }} of {{ database.total }} {{ database.total === 1 ? "row" : "rows" }}</span>
          <span class="hidden text-dimmed sm:inline">{{ selectedTable.columns.length }} {{ selectedTable.columns.length === 1 ? "column" : "columns" }}</span>
          <div class="ml-auto flex items-center gap-0.5">
            <UTooltip text="Previous page">
              <UButton aria-label="Previous page" icon="i-lucide-chevron-left" size="xs" variant="ghost" :disabled="!canGoBack || loading" @click="movePage(-1)" />
            </UTooltip>
            <UTooltip text="Next page">
              <UButton aria-label="Next page" icon="i-lucide-chevron-right" size="xs" variant="ghost" :disabled="!canGoForward || loading" @click="movePage(1)" />
            </UTooltip>
          </div>
        </footer>
      </main>

      <main
        v-else-if="database && view === 'schema'"
        class="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div class="schema-scroll min-h-0 flex-1 overflow-auto bg-elevated/20">
          <div
            class="schema-canvas relative"
            :style="{ height: `${schemaSize.height}px`, width: `${schemaSize.width}px` }"
          >
            <svg class="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
              <line
                v-for="line in schemaLines"
                :key="line.id"
                :x1="line.x1"
                :x2="line.x2"
                :y1="line.y1"
                :y2="line.y2"
                style="stroke: var(--ui-border-accented); opacity: 0.7"
                stroke-linecap="round"
                stroke-width="1.25"
              />
            </svg>
            <section
              v-for="table in database.tables"
              :key="table.name"
              class="schema-table absolute w-[280px] overflow-hidden rounded-md border border-default bg-default shadow-xs"
              :style="{ left: `${table.position.x}px`, top: `${table.position.y}px` }"
            >
              <button
                class="flex h-10 w-full items-center gap-2 border-b border-default px-3 text-left hover:bg-elevated/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
                type="button"
                @click="openTable(table.name)"
              >
                <UIcon name="i-lucide-table" class="size-3.5 text-dimmed" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-highlighted">{{ table.name }}</span>
                <span class="text-xs tabular-nums text-dimmed">{{ table.columns.length }}</span>
              </button>
              <ul>
                <li
                  v-for="column in table.columns"
                  :key="column.key"
                  class="flex h-[25px] items-center gap-1.5 border-b border-default/60 px-2.5 last:border-b-0"
                >
                  <UIcon
                    :name="column.primary ? 'i-lucide-key-round' : column.foreignKey ? 'i-lucide-link' : 'i-lucide-dot'"
                    class="size-3 shrink-0 text-dimmed"
                  />
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-toned">{{ column.name }}</span>
                  <span class="font-mono text-xs text-dimmed">{{ column.type }}</span>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </main>
    </UDashboardPanel>
  </ConsoleFrame>
</template>

<style scoped>
.schema-scroll {
  background-image: radial-gradient(
    color-mix(in oklab, var(--ui-border) 72%, transparent) 0.65px,
    transparent 0.65px
  );
  background-size: 16px 16px;
}

@media (max-width: 639px) {
  .schema-canvas {
    display: grid;
    height: auto !important;
    min-width: 100%;
    gap: 0.75rem;
    padding: 0.75rem;
    width: 100% !important;
  }

  .schema-canvas svg {
    display: none;
  }

  .schema-table {
    position: static;
    width: 100%;
  }
}
</style>
