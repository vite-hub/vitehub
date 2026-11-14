<script setup lang="ts">
import { consoleInitials, consoleTimeOfDay } from "../client/format";
import { Status } from "@vite-hub/ui";
import { computed, ref } from "vue";

import { consoleMcpAccount, consoleMcpAuthLabels, consoleMcpEndpoint, consoleMcpStatus, requestConsoleMcp } from "../client/mcp-client";
import { useConsoleToast } from "../client/toast";
import ConsoleMcpItems from "./console-mcp-items.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleState from "./console-state.vue";

import type { ConsoleMcpConnection } from "../mcp-client";
import ConsoleConfirm from "./console-confirm.vue";
import type { ConsoleProperty } from "./console-facts";
import ConsolePropertyList from "./console-property-list.vue";
import ConsoleSection from "./console-section.vue";
import ConsoleStatGrid from "./console-stat-grid.vue";

/**
 * One MCP connection: who it is signed in as, its server and grant, and its tools, resources, prompts, and server
 * details. The tokens stay on the server; this view shows only when they expire and what they allow.
 */
const props = defineProps<{
  connection: ConsoleMcpConnection;
  /** Connections to the same server, including this one. */
  peers: readonly ConsoleMcpConnection[];
}>();

const emit = defineEmits<{
  changed: [];
  connection: [connection: ConsoleMcpConnection];
  disconnected: [id: string];
}>();

type Tab = "prompts" | "resources" | "server" | "tools";
const tab = defineModel<string>("tab", { default: "tools" });
const item = defineModel<string | undefined>("item");

const toast = useConsoleToast();
const busy = ref<"disconnect" | "reconnect">();
const confirmOpen = ref(false);
const actionError = ref<unknown>();

const account = computed(() => consoleMcpAccount(props.connection));
// The page names the server. The summary under it names the account, so the two never repeat.
const serverTitle = computed(() => props.connection.server?.title ?? props.connection.server?.name ?? consoleMcpEndpoint(props.connection.url));
const status = computed(() => consoleMcpStatus[props.connection.status]);
const capabilities = computed(() => props.connection.server?.capabilities);
const tabs = computed(() => [
  // A server that has not said what it offers yet gets every tab, so a failed handshake does not hide them.
  ...(!capabilities.value || capabilities.value.tools ? [{ icon: "i-lucide-wrench", label: "Tools", value: "tools" }] : []),
  ...(!capabilities.value || capabilities.value.resources ? [{ icon: "i-lucide-file-text", label: "Resources", value: "resources" }] : []),
  ...(!capabilities.value || capabilities.value.prompts ? [{ icon: "i-lucide-message-square-text", label: "Prompts", value: "prompts" }] : []),
  { icon: "i-lucide-server", label: "Server", value: "server" },
]);
const activeTab = computed<Tab>({
  get: () => tabs.value.some(entry => entry.value === tab.value) ? tab.value as Tab : tabs.value[0]!.value as Tab,
  set: (value) => {
    item.value = undefined;
    tab.value = value;
  },
});
const needsSignIn = computed(() => props.connection.auth === "oauth" && props.connection.status !== "connected");
const expires = computed(() => {
  const value = props.connection.grant?.expiresAt;
  if (!value) return undefined;
  const time = consoleTimeOfDay(value);
  return Date.parse(value) < Date.now() ? `Expired at ${time}` : `Expires at ${time}`;
});
const facts = computed(() => {
  const server = props.connection.server;
  const grant = props.connection.grant;
  return [
    { label: "Server", value: server ? [server.title ?? server.name, server.version].filter(Boolean).join(" ") : "Not reached yet" },
    { label: "Protocol", mono: true, value: server?.protocolVersion ?? "—" },
    { label: "Session", mono: true, value: props.connection.session ? `…${props.connection.session}` : server ? "Stateless" : "—" },
    { label: "Sign-in", value: [consoleMcpAuthLabels[props.connection.auth], grant?.refreshable ? "refreshes" : undefined, expires.value?.toLowerCase()].filter(Boolean).join(" · ") },
  ];
});

const serverRows = computed(() => {
  const { grant, identity, server, url } = props.connection;
  const rows: { label: string, mono?: boolean, value?: string }[] = [
    { label: "Endpoint", mono: true, value: url },
    { label: "Name", mono: true, value: server?.name },
    { label: "Description", value: server?.description },
    { label: "Website", value: server?.websiteUrl },
    { label: "Capabilities", value: server ? Object.entries(server.capabilities).filter(([, on]) => on).map(([name]) => name).join(", ") || "None" : undefined },
    { label: "Authorization server", mono: true, value: grant?.issuer },
    { label: "Scopes", mono: true, value: grant?.scopes.join(" ") || undefined },
    { label: "Account id", mono: true, value: identity?.subject },
  ];
  return rows.filter((row): row is ConsoleProperty => Boolean(row.value));
});

async function reconnect(prompt?: "login"): Promise<void> {
  busy.value = "reconnect";
  actionError.value = undefined;
  try {
    const result = await requestConsoleMcp("mcp-client.reconnect", { id: props.connection.id, ...(prompt ? { prompt } : {}) });
    if (result.authorizationUrl) {
      window.location.assign(result.authorizationUrl);
      return;
    }
    emit("connection", result.connection);
    toast.show({ title: "New MCP session started" });
  }
  catch (cause) {
    actionError.value = cause;
    emit("changed");
  }
  finally {
    busy.value = undefined;
  }
}

async function disconnect(): Promise<void> {
  busy.value = "disconnect";
  try {
    const result = await requestConsoleMcp("mcp-client.disconnect", { id: props.connection.id });
    confirmOpen.value = false;
    const name = account.value.primary;
    toast.show({ title: props.connection.auth !== "oauth" || result.revoked ? `${name} disconnected` : `${name} disconnected. The server did not confirm that it revoked the token.` });
    emit("disconnected", props.connection.id);
  }
  catch (cause) {
    confirmOpen.value = false;
    actionError.value = cause;
    emit("changed");
  }
  finally {
    busy.value = undefined;
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <ConsolePageHeader :title="serverTitle" :description="consoleMcpEndpoint(connection.url)">
      <template #right>
        <UButton
          v-if="needsSignIn"
          icon="i-lucide-log-in"
          label="Sign in again"
          :loading="busy === 'reconnect'"
          @click="reconnect()"
        />
        <UTooltip v-else text="Start a new MCP session">
          <UButton aria-label="Start a new MCP session" icon="i-lucide-refresh-cw" variant="ghost" :loading="busy === 'reconnect'" @click="reconnect()" />
        </UTooltip>
        <UTooltip text="Disconnect">
          <UButton aria-label="Disconnect" icon="i-lucide-unplug" variant="ghost" :disabled="Boolean(busy)" @click="confirmOpen = true" />
        </UTooltip>
      </template>
    </ConsolePageHeader>

    <section class="shrink-0 border-b border-default" aria-label="Connection">
      <div class="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 px-4 py-4 sm:px-6">
        <div class="flex min-w-0 items-center gap-3">
          <UAvatar :src="connection.identity?.picture" :alt="account.primary" :text="consoleInitials(account.primary)" size="lg" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-highlighted">{{ account.primary }}</p>
            <p v-if="account.secondary" class="truncate text-xs text-muted">{{ account.secondary }}</p>
          </div>
          <UBadge :color="status.color" size="sm" class="shrink-0">
            <Status :tone="status.color" :label="status.label" />
          </UBadge>
        </div>
        <ConsoleStatGrid :items="facts" :columns="4" label="Connection facts">
          <template #value="{ item }"><span :class="item.mono ? 'font-mono text-xs' : ''">{{ item.value }}</span></template>
        </ConsoleStatGrid>
        <ConsoleState v-if="actionError" compact :error="actionError" title="That didn't work" />
        <div v-else-if="connection.error && connection.status !== 'connected'" role="status" class="flex flex-wrap items-center gap-2 rounded-md bg-elevated/50 px-3 py-2 text-[13px]">
          <UIcon name="i-lucide-circle-alert" class="size-4 shrink-0 text-warning" aria-hidden="true" />
          <span class="min-w-0 flex-1 text-pretty text-muted">{{ connection.error }}</span>
        </div>
      </div>
    </section>

    <!-- On a narrow screen the tab list scrolls sideways. The tab list draws its line 1px below itself, so the
         scroller makes room for it and overlaps the bottom border: the two are one line. -->
    <div class="shrink-0 border-b border-default">
      <div class="-mb-px overflow-x-auto pb-px">
        <div class="mx-auto max-w-6xl px-2 sm:px-4">
          <UTabs v-model="activeTab" :items="tabs" :content="false" aria-label="Connection views" class="w-max min-w-full" />
        </div>
      </div>
    </div>

    <ConsoleMcpItems
      v-if="activeTab !== 'server'"
      :key="`${connection.id}:${activeTab}`"
      v-model:selected="item"
      :connection="connection"
      :kind="activeTab"
      :peers="peers"
      @connection="emit('connection', $event)"
      @failed="emit('changed')"
    />
    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-4 py-5 sm:px-6 [&>*]:max-w-3xl">
        <ConsoleSection v-if="connection.server?.instructions" :level="3" title="Instructions">
          <p class="vitehub-mcp-text max-w-[75ch]">{{ connection.server.instructions }}</p>
        </ConsoleSection>
        <ConsolePropertyList title="Server" :items="serverRows" />
        <p class="max-w-[68ch] text-pretty text-xs text-dimmed">
          The Console keeps this connection in server memory. Its tokens never reach the browser, and it ends when the server restarts.
        </p>
      </div>
    </div>

    <ConsoleConfirm v-model:open="confirmOpen" :title="`Disconnect ${account.primary}?`" confirm-label="Disconnect" destructive :loading="busy === 'disconnect'" @confirm="disconnect">
      <p>
        The Console ends the MCP session<template v-if="connection.auth === 'oauth'"> and asks the authorization server to revoke the tokens</template>. To use this server as {{ account.primary }} again, connect again.
      </p>
    </ConsoleConfirm>
  </div>
</template>
