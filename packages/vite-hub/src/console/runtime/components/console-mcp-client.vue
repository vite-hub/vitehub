<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { consoleMcpAccount, consoleMcpEndpoint, consoleMcpInitials, consoleMcpStatus, groupConsoleMcpConnections, requestConsoleMcp } from "../client/mcp-client";
import { rememberConsoleSection } from "../sections";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMcpConnect from "./console-mcp-connect.vue";
import ConsoleMcpConnectionView from "./console-mcp-connection.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";

import type { ConsoleMcpConnection, ConsoleMcpOverview } from "../mcp-client";

/**
 * The MCP section: an MCP client in the Console. The sidebar groups connections by server, so the same server can be
 * open as several accounts at once. The URL keeps the selected connection, tab, and item.
 */
const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();

const overview = ref<ConsoleMcpOverview>();
const loading = ref(true);
const error = ref<unknown>();
const sidebarOpen = ref(false);
const connectOpen = ref(false);
const connectPreset = ref<{ another?: boolean, server: string }>();
let request: AbortController | undefined;

const groups = computed(() => overview.value ? groupConsoleMcpConnections(overview.value, window.location.origin) : []);
const connections = computed(() => overview.value?.connections ?? []);

function queryValue(name: string): string | undefined {
  const value = route.query[name];
  return typeof value === "string" && value ? value : undefined;
}

function setQuery(next: Record<string, string | undefined>): void {
  const query = { ...route.query, ...next };
  for (const key of Object.keys(query)) if (query[key] === undefined) delete query[key];
  void router.replace({ query });
}

const selected = computed(() => connections.value.find(connection => connection.id === queryValue("connection")) ?? connections.value[0]);
const peers = computed(() => selected.value ? connections.value.filter(connection => connection.url === selected.value!.url) : []);
const tab = computed({ get: () => queryValue("tab") ?? "tools", set: (value: string) => setQuery({ item: undefined, tab: value }) });
const item = computed({ get: () => queryValue("item"), set: (value: string | undefined) => setQuery({ item: value }) });

async function load(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = undefined;
  try {
    const next = await requestConsoleMcp(props.sectionsBase, "mcp-client.list", {}, controller.signal);
    if (!controller.signal.aborted) overview.value = next;
  }
  catch (cause) {
    if (!controller.signal.aborted) error.value = cause;
  }
  finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

function open(connection: ConsoleMcpConnection): void {
  sidebarOpen.value = false;
  if (connection.id !== selected.value?.id) setQuery({ connection: connection.id, item: undefined });
}

function connect(preset?: { another?: boolean, server: string }): void {
  connectPreset.value = preset;
  sidebarOpen.value = false;
  connectOpen.value = true;
}

/** Keep the list current with the state that a request returned, without loading the whole list again. */
function update(connection: ConsoleMcpConnection): void {
  if (!overview.value) return;
  const index = overview.value.connections.findIndex(candidate => candidate.id === connection.id);
  const next = [...overview.value.connections];
  if (index === -1) next.push(connection);
  else next[index] = connection;
  overview.value = { ...overview.value, connections: next };
}

function connected(connection: ConsoleMcpConnection): void {
  update(connection);
  setQuery({ connection: connection.id, item: undefined, tab: undefined });
}

function disconnected(id: string): void {
  if (overview.value) overview.value = { ...overview.value, connections: overview.value.connections.filter(connection => connection.id !== id) };
  setQuery({ connection: undefined, item: undefined, tab: undefined });
  void load();
}

/** Status marks differ in shape as well as color: a dot when connected, an icon otherwise. */
const statusIcons = { "authorizing": "i-lucide-clock-3", "connected": undefined, "failed": "i-lucide-circle-alert", "signed-out": "i-lucide-log-out" } as const;
const statusText = { error: "text-error", info: "text-info", success: "text-success", warning: "text-warning" } as const;

onMounted(() => {
  rememberConsoleSection("mcp-client");
  void load();
});
// A connection that the URL names but that no longer exists falls back to the first one.
watch(selected, (connection) => {
  if (connection && queryValue("connection") && connection.id !== queryValue("connection")) setQuery({ connection: connection.id, item: undefined });
});
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <ConsoleFrame active="mcp-client" :sections-base="sectionsBase">
    <UDashboardSidebar
      id="console-navigation"
      v-model:open="sidebarOpen"
      class="vitehub-console__nav"
      :default-size="16"
      :collapsed-size="4"
      :min-size="13"
      :max-size="26"
      :menu="{ title: 'MCP', description: 'MCP servers and the accounts connected to them.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0' }"
      resizable
    >
      <template #header="{ collapsed }">
        <div v-if="!collapsed" class="vitehub-console__panel-title">
          <span class="min-w-0 flex-1 truncate">MCP</span>
          <UTooltip text="Connect to a server">
            <UButton aria-label="Connect to a server" color="neutral" icon="i-lucide-plus" size="xs" variant="ghost" @click="connect()" />
          </UTooltip>
        </div>
      </template>

      <template #default="{ collapsed }">
        <nav class="vitehub-console__section-nav" :class="{ 'is-collapsed': collapsed }" aria-label="MCP connections">
          <template v-if="loading && !overview">
            <USkeleton v-for="index in 4" :key="index" class="my-0.5 h-11 rounded-md" />
          </template>
          <template v-for="(group, index) in groups" v-else :key="group.url">
            <div v-if="collapsed && index > 0" class="vitehub-console__section-rule" />
            <p v-if="!collapsed" class="vitehub-console__section-heading flex min-w-0 items-center gap-2" :title="group.url">
              <span class="min-w-0 truncate">{{ group.title }}</span>
              <span v-if="group.sameOrigin" class="vitehub-console__section-hint shrink-0">This app</span>
            </p>
            <UTooltip v-for="connection in group.connections" :key="connection.id" :text="`${consoleMcpAccount(connection).primary} · ${consoleMcpStatus[connection.status].label}`" :disabled="!collapsed" :content="{ side: 'right' }">
              <button
                type="button"
                class="vitehub-console__section-link is-detailed"
                :aria-current="selected?.id === connection.id ? 'true' : undefined"
                :aria-label="collapsed ? `${consoleMcpAccount(connection).primary}, ${consoleMcpStatus[connection.status].label}` : undefined"
                @click="open(connection)"
              >
                <UAvatar :src="connection.identity?.picture" :alt="consoleMcpAccount(connection).primary" :text="consoleMcpInitials(consoleMcpAccount(connection).primary)" size="xs" />
                <span v-if="!collapsed" class="grid min-w-0 flex-1 text-start">
                  <span class="truncate">{{ consoleMcpAccount(connection).primary }}</span>
                  <span v-if="consoleMcpAccount(connection).secondary" class="truncate text-xs font-normal text-dimmed">{{ consoleMcpAccount(connection).secondary }}</span>
                </span>
                <template v-if="!collapsed">
                  <UIcon v-if="statusIcons[connection.status]" :name="statusIcons[connection.status]!" class="size-3.5 shrink-0" :class="statusText[consoleMcpStatus[connection.status].color]" aria-hidden="true" />
                  <span v-else class="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                  <span class="sr-only">{{ consoleMcpStatus[connection.status].label }}</span>
                </template>
              </button>
            </UTooltip>
            <UTooltip :text="group.connections.length ? 'Add an account' : 'Connect'" :disabled="!collapsed" :content="{ side: 'right' }">
              <button
                type="button"
                class="vitehub-console__section-link text-dimmed"
                :aria-label="collapsed ? `${group.connections.length ? 'Add an account to' : 'Connect to'} ${group.title}` : undefined"
                @click="connect({ another: group.connections.length > 0, server: group.url })"
              >
                <UIcon :name="group.connections.length ? 'i-lucide-user-plus' : 'i-lucide-plug'" class="vitehub-console__section-icon" aria-hidden="true" />
                <span v-if="!collapsed" class="truncate font-normal">{{ group.connections.length ? "Add an account" : "Connect" }}</span>
              </button>
            </UTooltip>
          </template>
          <p v-if="!collapsed && overview && !groups.length" class="px-2 py-1.5 text-xs text-muted">No servers yet.</p>
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

    <UDashboardPanel id="mcp-client" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <ConsoleMcpConnectionView
        v-if="selected"
        :key="selected.id"
        v-model:tab="tab"
        v-model:item="item"
        :base="sectionsBase"
        :connection="selected"
        :peers="peers"
        @changed="load"
        @connection="update"
        @disconnected="disconnected"
      />
      <template v-else>
        <ConsolePageHeader title="MCP">
          <template #right>
            <UButton color="neutral" icon="i-lucide-plus" label="Connect" size="sm" variant="soft" @click="connect()" />
          </template>
        </ConsolePageHeader>
        <main class="min-h-0 flex-1 overflow-auto">
          <ConsoleState v-if="error" :error="error" title="Couldn't load MCP connections" :retry="load" />
          <div v-else-if="loading && !overview" class="mx-auto grid w-full max-w-xl gap-3 p-6" aria-busy="true">
            <USkeleton class="h-6 w-56" />
            <USkeleton class="h-16 w-full" />
          </div>
          <ConsoleState
            v-else
            section="mcp-client"
            icon="i-lucide-cable"
            title="Connect to an MCP server"
            description="The Console connects from the server as you, with OAuth or a token, and keeps every token on the server. Connect again as other accounts to compare what each one sees."
            :actions="[{ label: 'Another server', icon: 'i-lucide-plus', onClick: () => connect() }]"
          >
            <ul v-if="overview?.servers.length" class="grid w-full max-w-md gap-2 text-start">
              <li v-for="candidate in overview.servers" :key="candidate.url" class="flex min-w-0 items-center gap-3 rounded-lg border border-default px-3 py-2.5">
                <UIcon name="i-lucide-server" class="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span class="grid min-w-0 flex-1">
                  <span class="truncate text-[13px] font-medium text-highlighted">{{ candidate.label }}</span>
                  <span class="truncate font-mono text-xs text-dimmed">{{ consoleMcpEndpoint(candidate.url) }}</span>
                </span>
                <UButton size="xs" label="Connect" :aria-label="`Connect to ${candidate.label}`" @click="connect({ server: candidate.url })" />
              </li>
            </ul>
          </ConsoleState>
        </main>
      </template>
    </UDashboardPanel>

    <ConsoleMcpConnect
      v-model:open="connectOpen"
      :base="sectionsBase"
      :preset="connectPreset"
      :servers="overview?.servers ?? []"
      :shared-session="overview?.sharedSession ?? false"
      @connected="connected"
    />
  </ConsoleFrame>
</template>
