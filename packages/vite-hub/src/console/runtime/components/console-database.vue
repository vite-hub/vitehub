<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleDatabaseRelationship, ConsoleDatabaseTable } from "./console-database-model";
import { requestConsole } from "../client/request";
import { resolveConsoleRouteName } from "../console-route";
import { rememberConsoleSection } from "../sections";
import { parseConsoleDatabase } from "./console-database-model";
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
const sidebarCollapsed = ref(false);
const filter = ref("");
const database = ref<ReturnType<typeof parseConsoleDatabase>>();
const loading = ref(true);
const error = ref<unknown>();
let request: AbortController | undefined;

const selectedTable = computed(() => {
  const routeTable = Array.isArray(route.params.table) ? route.params.table[0] : route.params.table;
  return (
    database.value?.tables.find((table) => table.name === routeTable) ?? database.value?.tables[0]
  );
});
const columns = computed<TableColumn<Record<string, string>>[]>(() =>
  (selectedTable.value?.columns ?? []).map((column) => ({
    accessorKey: column.name,
    header: column.name,
  })),
);
const filteredRows = computed(() => {
  const rows = selectedTable.value?.rows ?? [];
  const query = filter.value.trim().toLocaleLowerCase();
  return rows
    .filter(
      (row) =>
        !query ||
        Object.values(row).some((value) => formatValue(value).toLocaleLowerCase().includes(query)),
    )
    .map((row) =>
      Object.fromEntries(
        (selectedTable.value?.columns ?? []).map((column) => [
          column.name,
          formatValue(row[column.name]),
        ]),
      ),
    );
});
const schemaSize = computed(() => {
  const tables = database.value?.tables ?? [];
  return {
    height: Math.max(720, ...tables.map((table) => table.position.y + tableHeight(table) + 48)),
    width: Math.max(1060, ...tables.map((table) => table.position.x + 304)),
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

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Object) return JSON.stringify(value);
  return String(value);
}

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
  const pointsRight =
    side === "from"
      ? table.position.x <
        (database.value?.tables.find((entry) => entry.name === relationship.to.table)?.position.x ??
          table.position.x)
      : table.position.x <
        (database.value?.tables.find((entry) => entry.name === relationship.from.table)?.position
          .x ?? table.position.x);
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

async function loadDatabase(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  try {
    const value = parseConsoleDatabase(
      await requestConsole(props.databaseBase, { signal: controller.signal }),
    );
    if (request !== controller) return;
    database.value = value;
    error.value = undefined;
    if (props.view === "data" && !value.tables.some((table) => table.name === route.params.table)) {
      await openTable(value.tables[0]!.name, true);
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
  sidebarOpen.value = false;
  filter.value = "";
  const location = {
    name: resolveConsoleRouteName(route.name, "vitehub-console-database"),
    params: { table: name },
  };
  await (replace ? router.replace(location) : router.push(location));
}

async function openSchema(): Promise<void> {
  sidebarOpen.value = false;
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-database-schema"),
  });
}

onMounted(() => {
  rememberConsoleSection("database");
  void loadDatabase();
});
watch(
  () => route.params.table,
  () => {
    filter.value = "";
  },
);
onBeforeUnmount(() => request?.abort());
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

        <nav class="grid gap-0.5 border-b border-default px-2 pb-2" aria-label="Database views">
          <UTooltip text="Table editor" :disabled="!collapsed" :content="{ side: 'right' }">
            <UButton
              block
              class="justify-start"
              color="neutral"
              icon="i-ph-table-light"
              :label="collapsed ? undefined : 'Table editor'"
              :aria-label="collapsed ? 'Table editor' : undefined"
              :variant="view === 'data' ? 'soft' : 'ghost'"
              @click="selectedTable && openTable(selectedTable.name)"
            />
          </UTooltip>
          <UTooltip text="Schema" :disabled="!collapsed" :content="{ side: 'right' }">
            <UButton
              block
              class="justify-start"
              color="neutral"
              icon="i-ph-share-network-light"
              :label="collapsed ? undefined : 'Schema'"
              :aria-label="collapsed ? 'Schema' : undefined"
              :variant="view === 'schema' ? 'soft' : 'ghost'"
              @click="openSchema"
            />
          </UTooltip>
        </nav>

        <div v-if="!collapsed" class="flex items-center justify-between px-3 pb-1.5 pt-3">
          <span class="font-mono text-[10px] font-medium uppercase tracking-[.1em] text-muted">
            {{ database?.schema || "Schema" }}
          </span>
          <span class="text-[10px] tabular-nums text-muted">{{
            database?.tables.length || 0
          }}</span>
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
              <span
                v-if="!collapsed"
                class="flex min-w-0 flex-1 items-center justify-between gap-2"
              >
                <span class="truncate font-mono text-xs">{{ table.name }}</span>
                <span class="text-[10px] tabular-nums text-muted">{{ table.rows.length }}</span>
              </span>
            </UButton>
          </UTooltip>
        </nav>
      </template>

      <template #footer="{ collapsed, collapse }">
        <ConsolePrimitiveSwitcher
          active="database"
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
          :title="view === 'schema' ? 'Schema' : selectedTable?.name || 'Table editor'"
          :toggle="{ 'aria-label': 'Open database navigation' }"
          :ui="{ root: 'border-b border-default' }"
        >
          <template #leading>
            <UIcon
              :name="view === 'schema' ? 'i-ph-share-network-light' : 'i-ph-table-light'"
              class="size-3.5 text-muted opacity-65"
            />
          </template>
          <template #right>
            <span v-if="database" class="hidden font-mono text-[10px] text-muted sm:inline">{{
              database.schema
            }}</span>
            <UBadge color="neutral" label="Read-only" size="sm" variant="subtle" />
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
            <div class="mr-auto flex min-w-0 items-center gap-1.5 text-xs">
              <span class="font-mono text-muted">{{ database.schema }}</span>
              <UIcon name="i-ph-caret-right-light" class="size-3 text-muted opacity-50" />
              <span class="truncate font-mono font-medium text-highlighted">{{
                selectedTable.name
              }}</span>
            </div>
            <UInput
              v-model="filter"
              class="w-48 sm:w-56"
              icon="i-ph-magnifying-glass-light"
              :placeholder="`Filter ${selectedTable.name}`"
              aria-label="Filter rows"
            />
            <UTooltip text="Refresh table">
              <UButton
                aria-label="Refresh table"
                color="neutral"
                icon="i-ph-arrows-clockwise-light"
                size="xs"
                variant="ghost"
                :loading="loading"
                @click="loadDatabase"
              />
            </UTooltip>
          </header>

          <div class="min-h-0 flex-1 overflow-auto">
            <UTable
              :columns="columns"
              :data="filteredRows"
              :empty="filter ? 'No rows match this filter.' : 'This table is empty.'"
              sticky="header"
              :ui="{
                base: 'min-w-max',
                th: 'whitespace-nowrap border-r border-default last:border-r-0',
                td: 'max-w-64 whitespace-nowrap border-r border-default font-mono last:border-r-0',
                tr: 'border-b border-default hover:bg-elevated/35',
              }"
            />
          </div>
          <footer
            class="flex h-8 shrink-0 items-center justify-between border-t border-default px-3 text-[10px] text-muted"
          >
            <span>{{ filteredRows.length }} of {{ selectedTable.rows.length }} rows</span>
            <span>{{ selectedTable.columns.length }} columns</span>
          </footer>
        </main>

        <main
          v-else-if="database && view === 'schema'"
          class="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <header class="flex min-h-10 items-center gap-2 border-b border-default px-3 py-1.5">
            <span class="text-xs font-medium text-highlighted">{{ database.schema }} schema</span>
            <span class="text-[10px] text-muted"
              >{{ database.tables.length }} tables ·
              {{ database.relationships.length }} relationships</span
            >
          </header>
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
                  <span class="text-[10px] tabular-nums text-muted">{{ table.rows.length }}</span>
                </button>
                <ul>
                  <li
                    v-for="column in table.columns"
                    :key="column.name"
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
