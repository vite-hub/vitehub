<script setup lang="ts">
import type { TableColumn, TableRow } from "@nuxt/ui";
import type { ConnectionInspection } from "@vite-hub/connections";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  connectionApprovalCountsSchema,
  connectionConnectURL,
  connectionCredentialLabel,
  connectionListSchema,
  connectionNextStep,
  connectionStatusColor,
  connectionStatusLabel,
  requestConnectionsManagement,
} from "../client/connections-management";
import { consolePrimitives, rememberConsoleSection } from "../sections";
import ConsoleConnectionsDetails from "./console-connections-details.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";

type DetailsTab = "activity" | "approvals" | "details";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  managementBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const connections = ref<readonly ConnectionInspection[]>([]);
const pending = ref(new Map<string, number>());
const search = ref("");
const selectedName = ref<string>();
const selectedTab = ref<DetailsTab>("details");
const selectedKeyForm = ref(false);
const loading = ref(true);
const error = ref<unknown>();
// The provider flow returns to this page when it ends. The Console renders this page only in the browser.
const returnTo = window.location.pathname;
const setupURL = consolePrimitives.find((primitive) => primitive.id === "connections")?.setup;
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
    `${connection.name} ${connection.provider} ${connectionCredentialLabel(connection.credential)} ${connection.account?.email ?? ""}`
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
);
const columns: TableColumn<ConnectionInspection>[] = [
  { accessorKey: "name", header: "Connection" },
  { id: "credential", header: "Type" },
  { id: "status", header: "Status" },
  { id: "account", header: "Account" },
  { id: "action", header: "Action", meta: { class: { th: "sr-only", td: "w-px whitespace-nowrap text-right" } } },
];
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function open(name: string, tab: DetailsTab = "details", keyForm = false) {
  selectedTab.value = tab;
  selectedKeyForm.value = keyForm;
  selectedName.value = name;
}
function selectRow(_event: Event, row: TableRow<ConnectionInspection>) {
  open(row.original.name);
}
async function refresh() {
  request?.abort();
  const current = new AbortController();
  request = current;
  loading.value = true;
  error.value = undefined;
  try {
    const [list, counts] = await Promise.all([
      requestConnectionsManagement(props.managementBase, "list", connectionListSchema),
      requestConnectionsManagement(props.managementBase, "approval-counts", connectionApprovalCountsSchema),
    ]);
    if (current.signal.aborted) return;
    connections.value = list.connections;
    pending.value = new Map(Object.entries(counts.counts));
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause;
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
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-default px-4 py-2">
          <UInput
            v-model="search"
            aria-label="Search Connections"
            placeholder="Search Connections…"
            icon="i-ph-magnifying-glass-light"
            variant="none"
            class="min-w-40 flex-1"
          />
          <p class="text-xs text-dimmed">
            Defined in <code class="font-mono text-muted">server/connections/</code>
            <template v-if="setupURL">
              ·
              <a
                :href="setupURL"
                target="_blank"
                rel="noopener"
                class="rounded-sm text-muted underline-offset-2 outline-none hover:text-highlighted hover:underline focus-visible:ring-1 focus-visible:ring-primary"
                >Add a Connection<span class="sr-only"> (opens in a new tab)</span></a
              >
            </template>
          </p>
        </div>
      </template>
      <template #body>
        <main class="min-h-0 flex-1 overflow-auto">
          <ConsoleState v-if="error" :error="error" title="Could not load Connections" :retry="refresh" />
          <p v-else-if="loading" role="status" class="p-4 text-sm text-muted">
            Loading Connections…
          </p>
          <ConsoleState
            v-else-if="!connections.length"
            section="connections"
            icon="i-ph-plugs-connected-light"
            title="No Connections yet"
            description="Connections are defined in code. Add a file to server/connections/, then connect it here."
          >
            <pre
              aria-label="Example Connection Definition"
              class="max-w-full overflow-x-auto rounded-md bg-elevated/50 px-3 py-2.5 text-left font-mono text-[11px] leading-5 text-toned"
            ><code>// server/connections/crm.ts
import { apiKey, defineConnection } from 'vite-hub/connections'

export default defineConnection({
  provider: apiKey({ id: 'crm', origins: ['https://api.crm.example.com'] }),
})</code></pre>
          </ConsoleState>
          <UTable
            v-else
            :data="rows"
            :columns="columns"
            :on-select="selectRow"
            empty="No matching Connections."
            :ui="{
              tr: 'group cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
            }"
          >
            <template #name-cell="{ row }"
              ><span class="font-mono text-xs text-highlighted">{{ row.original.name }}</span
              ><span
                v-if="row.original.provider !== row.original.name"
                class="ms-2 text-xs text-dimmed"
                >{{ row.original.provider }}</span
              ></template
            >
            <template #credential-cell="{ row }"
              ><span class="inline-flex items-center gap-1.5 text-xs text-muted"
                ><UIcon
                  :name="row.original.credential === 'api-key' ? 'i-ph-key-light' : 'i-ph-sign-in-light'"
                  class="size-3.5 shrink-0"
                />{{ connectionCredentialLabel(row.original.credential) }}</span
              ></template
            >
            <template #status-cell="{ row }"
              ><div class="flex flex-wrap items-center gap-1.5">
                <UBadge
                  :color="connectionStatusColor(row.original.status)"
                  :label="connectionStatusLabel(row.original.status)"
                  size="sm"
                  variant="subtle"
                />
                <UBadge
                  v-if="row.original.scopes.missing.length"
                  color="warning"
                  :label="plural(row.original.scopes.missing.length, 'missing scope')"
                  size="sm"
                  variant="subtle"
                />
                <UButton
                  v-if="pending.get(row.original.name)"
                  color="warning"
                  :label="plural(pending.get(row.original.name) ?? 0, 'pending approval')"
                  :aria-label="`Review ${plural(pending.get(row.original.name) ?? 0, 'pending approval')} for ${row.original.name}`"
                  size="xs"
                  variant="soft"
                  @click.stop="open(row.original.name, 'approvals')"
                /></div
            ></template>
            <template #account-cell="{ row }"
              ><span v-if="row.original.account" class="break-all text-xs text-muted">{{
                row.original.account.email ?? row.original.account.id
              }}</span></template
            >
            <template #action-cell="{ row }"
              ><div class="flex items-center justify-end gap-2">
                <template v-if="connectionNextStep(row.original)">
                  <UButton
                    v-if="connectionNextStep(row.original)?.kind === 'connect'"
                    :label="connectionNextStep(row.original)?.label"
                    :aria-label="`${connectionNextStep(row.original)?.label} ${row.original.name}`"
                    :to="connectionConnectURL(managementBase, row.original.name, returnTo)"
                    external
                    color="neutral"
                    size="xs"
                    trailing-icon="i-ph-arrow-up-right-light"
                    variant="outline"
                    @click.stop
                  />
                  <UButton
                    v-else
                    :label="connectionNextStep(row.original)?.label"
                    :aria-label="`${connectionNextStep(row.original)?.label} for ${row.original.name}`"
                    color="neutral"
                    icon="i-ph-key-light"
                    size="xs"
                    variant="outline"
                    @click.stop="open(row.original.name, 'details', true)"
                  />
                </template>
                <UIcon
                  name="i-lucide-chevron-right"
                  aria-hidden="true"
                  class="size-3.5 text-dimmed group-hover:text-muted"
                /></div
            ></template>
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
          :initial-tab="selectedTab"
          :key-form="selectedKeyForm"
          :return-to="returnTo"
          @changed="refresh"
      /></template>
    </USlideover>
  </ConsoleFrame>
</template>
