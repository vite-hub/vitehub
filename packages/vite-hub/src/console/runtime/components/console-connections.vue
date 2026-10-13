<script setup lang="ts">
import type { TableColumn, TableRow } from "@nuxt/ui";
import type { ConnectionInspection } from "@vite-hub/connections";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  connectionApprovalCountsSchema,
  connectionListSchema,
  connectionStatusLabel,
  requestConnectionsManagement,
} from "../client/connections-management";
import { rememberConsoleSection } from "../sections";
import ConsoleConnectionsDetails from "./console-connections-details.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleSearch from "./console-search.vue";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  managementBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const connections = ref<readonly ConnectionInspection[]>([]);
const pending = ref<Record<string, number>>({});
const search = ref("");
const selectedName = ref<string>();
const loading = ref(true);
const error = ref("");
let request: AbortController | undefined;
const selected = computed(() =>
  connections.value.find((connection) => connection.name === selectedName.value),
);
const detailOpen = computed({
  get: () => Boolean(selected.value),
  set: (open: boolean) => {
    if (!open) selectedName.value = undefined;
  },
});
const rows = computed(() =>
  connections.value.filter((connection) =>
    `${connection.name} ${connection.provider} ${connection.account?.email ?? ""}`
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
);
const columns: TableColumn<ConnectionInspection>[] = [
  { accessorKey: "name", header: "Connection" },
  { accessorKey: "provider", header: "Provider" },
  { id: "status", header: "Status" },
  { id: "account", header: "Account" },
  { id: "missing", header: "Missing scopes" },
  { id: "approvals", header: "Pending approvals" },
];
function selectRow(_event: Event, row: TableRow<ConnectionInspection>) {
  selectedName.value = row.original.name;
}
async function refresh() {
  request?.abort();
  const current = new AbortController();
  request = current;
  loading.value = true;
  error.value = "";
  try {
    const [list, counts] = await Promise.all([
      requestConnectionsManagement(props.managementBase, "list", connectionListSchema),
      requestConnectionsManagement(props.managementBase, "approval-counts", connectionApprovalCountsSchema),
    ]);
    if (current.signal.aborted) return;
    connections.value = list.connections;
    pending.value = counts.counts;
  } catch (cause) {
    if (!current.signal.aborted) {
      error.value = cause instanceof Error ? cause.message : "Could not load Connections.";
    }
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}
onMounted(() => {
  rememberConsoleSection("connections");
  void refresh();
});
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <ConsoleFrame active="connections" :sections-base="sectionsBase">
    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />
    <UDashboardPanel id="connections" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <template #header>
        <UDashboardNavbar title="Connections" :toggle="false">
          <template #right>
            <UTooltip text="Refresh Connections"
              ><UButton
                aria-label="Refresh Connections"
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
            aria-label="Search Connections"
            placeholder="Search Connections…"
            icon="i-ph-magnifying-glass-light"
            variant="none"
            class="min-w-40 flex-1"
          />
        </div>
      </template>
      <template #body>
        <main class="min-h-0 flex-1 overflow-auto">
          <div v-if="error" role="alert" class="flex items-center gap-3 p-4 text-sm">
            <span>{{ error }}</span
            ><UButton label="Try again" color="neutral" variant="ghost" @click="refresh" />
          </div>
          <p v-else-if="loading" role="status" class="p-4 text-sm text-muted">
            Loading Connections…
          </p>
          <UTable
            v-else
            :data="rows"
            :columns="columns"
            :on-select="selectRow"
            :empty="connections.length ? 'No matching Connections.' : 'No Connections defined.'"
            :ui="{
              tr: 'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
            }"
          >
            <template #name-cell="{ row }"
              ><span class="font-mono text-xs text-highlighted">{{
                row.original.name
              }}</span></template
            >
            <template #provider-cell="{ row }"
              ><span class="text-xs text-muted">{{ row.original.provider }}</span></template
            >
            <template #status-cell="{ row }"
              ><span
                :class="[
                  'text-xs',
                  row.original.status === 'reauth_required' ? 'text-error' : 'text-muted',
                ]"
                >{{ connectionStatusLabel(row.original.status) }}</span
              ></template
            >
            <template #account-cell="{ row }"
              ><span class="break-all text-xs text-muted">{{
                row.original.account?.email ?? row.original.account?.id ?? "None"
              }}</span></template
            >
            <template #missing-cell="{ row }"
              ><span
                :class="[
                  'break-all text-xs',
                  row.original.scopes.missing.length ? 'text-error' : 'text-muted',
                ]"
                >{{ row.original.scopes.missing.join(", ") || "None" }}</span
              ></template
            >
            <template #approvals-cell="{ row }"
              ><span class="text-xs text-muted tabular-nums">{{
                pending[row.original.name] ?? 0
              }}</span></template
            >
          </UTable>
        </main>
      </template>
    </UDashboardPanel>
    <USlideover
      v-model:open="detailOpen"
      :title="selected?.name ?? 'Connection'"
      description="Connection details"
      :ui="{ description: 'sr-only' }"
    >
      <template #body
        ><ConsoleConnectionsDetails
          v-if="selected"
          :key="selected.name"
          :connection="selected"
          :endpoint="managementBase"
          @changed="refresh"
      /></template>
    </USlideover>
  </ConsoleFrame>
</template>
