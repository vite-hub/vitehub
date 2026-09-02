<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleDatabaseRelationship, ConsoleDatabaseTable } from "./console-database-model";
import { requestConsole } from "../client/request";
import { resolveConsoleRouteName } from "../console-route";
import { rememberConsoleSection } from "../sections";
import { consoleDatabaseRequestQuery, parseConsoleDatabase } from "./console-database-model";
import ConsoleBrand from "./console-brand.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleSearch from "./console-search.vue";

interface SchemaLine {
  id: string;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

const props = withDefaults(
  defineProps<{
    agentsBase: string;
    databaseBase: string;
    definitionsBase: string;
    kvBase: string;
    searchBase: string;
    section?: "database" | "databases";
    sectionsBase: string;
    view: "data" | "schema";
  }>(),
  { section: "database" },
);

const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
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

const dataRouteName = computed(() =>
  props.section === "databases" ? "vitehub-console-databases" : "vitehub-console-database",
);
const schemaRouteName = computed(() =>
  props.section === "databases"
    ? "vitehub-console-databases-schema"
    : "vitehub-console-database-schema",
);
const routeDatabase = computed(() => {
  const value = Array.isArray(route.params.database)
    ? route.params.database[0]
    : route.params.database;
  return props.section === "databases" ? value : database.value?.database;
});
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
  return props.section === "databases" ? { database: databaseName, table } : { table };
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
          name: resolveConsoleRouteName(route.name, dataRouteName.value),
          params: routeParams(value.database, table),
        });
      }
    } else if (props.section === "databases" && routeDatabase.value !== value.database) {
      await router.replace({
        name: resolveConsoleRouteName(route.name, schemaRouteName.value),
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
  resetTableState();
  const location = {
    name: resolveConsoleRouteName(route.name, dataRouteName.value),
    params: routeParams(databaseName, name),
  };
  await (replace ? router.replace(location) : router.push(location));
}

async function openDatabase(value: unknown): Promise<void> {
  if (typeof value !== "string" || value === database.value?.database) return;
  sidebarOpen.value = false;
  resetTableState();
  await router.push({
    name: resolveConsoleRouteName(route.name, dataRouteName.value),
    params: routeParams(value),
  });
}

async function openSchema(): Promise<void> {
  const databaseName = database.value?.database ?? routeDatabase.value;
  if (!databaseName) return;
  sidebarOpen.value = false;
  resetTableState();
  await router.push({
    name: resolveConsoleRouteName(route.name, schemaRouteName.value),
    params: props.section === "databases" ? { database: databaseName } : {},
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
  rememberConsoleSection(props.section);
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
  <ConsoleFrame>
    <UDashboardSidebar
      id="database-tables"
      v-model:open="sidebarOpen"
      v-model:collapsed="sidebarCollapsed"
      :default-size="19"
      :collapsed-size="4"
      :min-size="16"
      :max-size="24"
      :menu="{ title: 'Database', description: 'Inspect tables and relationships.' }"
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

        <div v-if="!collapsed" class="flex items-center gap-2 px-3 pb-1.5 pt-3">
          <span class="font-mono text-[10px] font-medium uppercase tracking-[.1em] text-muted">
            Database
          </span>
          <span class="ml-auto text-[10px] tabular-nums text-muted">{{
            database?.tables.length || 0
          }}</span>
        </div>
        <div v-if="!collapsed && database" class="px-2 pb-2">
          <USelect
            v-if="database.databases.length > 1"
            :model-value="database.database"
            :items="databaseItems"
            class="w-full"
            aria-label="Database"
            size="sm"
            @update:model-value="openDatabase"
          />
          <div v-else class="px-2 py-1 font-mono text-xs text-toned">{{ database.database }}</div>
        </div>
        <div v-if="loading && !database" class="grid gap-1 px-2 py-1">
          <USkeleton v-for="index in 5" :key="index" :class="collapsed ? 'h-8' : 'h-9'" />
        </div>
        <nav
          v-else-if="database"
          class="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          aria-label="Database tables"
        >
          <UTooltip
            v-for="table in database.tables"
            :key="table.name"
            :text="table.name"
            :disabled="!collapsed"
            :content="{ side: 'right' }"
          >
            <UButton
              block
              class="justify-start"
              color="neutral"
              icon="i-ph-table-light"
              :variant="view === 'data' && selectedTable?.name === table.name ? 'soft' : 'ghost'"
              :aria-label="collapsed ? table.name : undefined"
              @click="openTable(table.name)"
            >
              <span v-if="!collapsed" class="min-w-0 flex-1 truncate text-start font-mono text-xs">
                {{ table.name }}
              </span>
            </UButton>
          </UTooltip>
        </nav>
      </template>

      <template #footer="{ collapsed, collapse }">
        <ConsolePrimitiveSwitcher
          :active="section"
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

    <UDashboardPanel id="database-inspector" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <template #header>
        <UDashboardNavbar
          :toggle="{ 'aria-label': 'Open database navigation' }"
          :ui="{ root: 'border-0', title: 'min-w-0 flex-1' }"
        >
          <template #title>
            <div class="flex min-w-0 items-center gap-2 text-sm">
              <UIcon name="i-lucide-database" class="size-3.5 shrink-0 text-muted" />
              <span class="max-w-40 shrink-0 truncate font-normal text-muted">{{
                database?.database || "Database"
              }}</span>
              <span class="text-dimmed" aria-hidden="true">/</span>
              <strong class="min-w-0 truncate font-medium text-highlighted">
                {{ view === "schema" ? "Schema" : selectedTable?.name || "Table" }}
              </strong>
            </div>
          </template>
          <template #right>
            <UTooltip text="Table data">
              <UButton
                aria-label="Table data"
                color="neutral"
                icon="i-ph-table-light"
                size="sm"
                :variant="view === 'data' ? 'soft' : 'ghost'"
                @click="selectedTable && openTable(selectedTable.name)"
              />
            </UTooltip>
            <UTooltip text="Schema diagram">
              <UButton
                aria-label="Schema diagram"
                color="neutral"
                icon="i-ph-share-network-light"
                size="sm"
                :variant="view === 'schema' ? 'soft' : 'ghost'"
                @click="openSchema"
              />
            </UTooltip>
            <UTooltip text="Refresh database">
              <UButton
                aria-label="Refresh database"
                color="neutral"
                icon="i-lucide-refresh-cw"
                size="sm"
                variant="ghost"
                :loading="loading"
                @click="loadDatabase"
              />
            </UTooltip>
            <UBadge
              class="hidden sm:inline-flex"
              color="neutral"
              label="Read-only"
              size="sm"
              variant="soft"
            />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <UAlert
          v-if="errorMessage(error)"
          class="m-3"
          color="error"
          variant="subtle"
          icon="i-ph-cloud-slash-light"
          title="Could not load database"
          :description="errorMessage(error)"
          :actions="[
            { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: loadDatabase },
          ]"
        />
        <div
          v-else-if="loading && !database"
          class="flex min-h-0 flex-1 items-center justify-center"
        >
          <UIcon name="i-ph-circle-notch-light" class="size-4 animate-spin text-muted opacity-70" />
        </div>

        <main
          v-else-if="database && view === 'data' && selectedTable"
          class="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <header
            class="flex min-h-10 flex-wrap items-center gap-2 border-b border-default px-2.5 py-1.5"
          >
            <UInput
              v-model="filter"
              class="mr-auto w-52 sm:w-64"
              icon="i-ph-magnifying-glass-light"
              :placeholder="`Filter ${selectedTable.name}`"
              aria-label="Filter rows"
            />
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
                color="neutral"
                :icon="
                  direction === 'asc'
                    ? 'i-lucide-arrow-up-narrow-wide'
                    : 'i-lucide-arrow-down-wide-narrow'
                "
                size="sm"
                variant="ghost"
                @click="toggleDirection"
              />
            </UTooltip>
          </header>

          <div class="min-h-0 flex-1 overflow-auto">
            <UTable
              :columns="columns"
              :data="tableRows"
              :empty="appliedSearch ? 'No rows match this filter.' : 'This table is empty.'"
              :loading="loading"
              sticky="header"
              :ui="{
                base: 'min-w-max',
                th: 'whitespace-nowrap border-r border-default last:border-r-0',
                td: 'max-w-72 whitespace-nowrap border-r border-default font-mono last:border-r-0',
                tr: 'border-b border-default hover:bg-elevated/35',
              }"
            />
          </div>
          <footer
            class="flex h-9 shrink-0 items-center gap-2 border-t border-default px-3 text-[10px] text-muted"
          >
            <span>{{ pageStart }}–{{ pageEnd }} of {{ database.total }} rows</span>
            <span class="hidden sm:inline">{{ selectedTable.columns.length }} columns</span>
            <div class="ml-auto flex items-center gap-0.5">
              <UTooltip text="Previous page">
                <UButton
                  aria-label="Previous page"
                  color="neutral"
                  icon="i-lucide-chevron-left"
                  size="xs"
                  variant="ghost"
                  :disabled="!canGoBack || loading"
                  @click="movePage(-1)"
                />
              </UTooltip>
              <UTooltip text="Next page">
                <UButton
                  aria-label="Next page"
                  color="neutral"
                  icon="i-lucide-chevron-right"
                  size="xs"
                  variant="ghost"
                  :disabled="!canGoForward || loading"
                  @click="movePage(1)"
                />
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
                class="schema-table absolute w-[280px] overflow-hidden rounded-lg border border-default bg-default shadow-sm"
                :style="{ left: `${table.position.x}px`, top: `${table.position.y}px` }"
              >
                <button
                  class="flex h-10 w-full items-center gap-2 border-b border-default px-3 text-left hover:bg-elevated/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
                  type="button"
                  @click="openTable(table.name)"
                >
                  <UIcon name="i-ph-table-light" class="size-3.5 text-muted opacity-70" />
                  <span
                    class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-highlighted"
                    >{{ table.name }}</span
                  >
                  <span class="text-[10px] tabular-nums text-muted">{{
                    table.columns.length
                  }}</span>
                </button>
                <ul>
                  <li
                    v-for="column in table.columns"
                    :key="column.key"
                    class="flex h-[25px] items-center gap-1.5 border-b border-default/60 px-2.5 last:border-b-0"
                  >
                    <UIcon
                      :name="
                        column.primary
                          ? 'i-ph-key-light'
                          : column.foreignKey
                            ? 'i-ph-link-simple-light'
                            : 'i-ph-dot-outline-fill'
                      "
                      class="size-3 shrink-0 text-muted opacity-60"
                    />
                    <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-toned">{{
                      column.name
                    }}</span>
                    <span class="font-mono text-[9px] text-muted">{{ column.type }}</span>
                  </li>
                </ul>
              </section>
            </div>
          </div>
        </main>
      </template>
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
