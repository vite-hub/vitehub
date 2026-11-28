<script setup lang="ts">
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle, CopyButton } from "@vite-hub/ui";
import { computed, onMounted, ref, shallowRef } from "vue";

import type { ConsoleMcpConnection } from "../client/account";
import { listConsoleMcpConnections, revokeConsoleMcpConnection } from "../client/account";
import { useConsoleProjects } from "../client/project-session";
import { useConsoleToast } from "../client/toast";
import ConsoleSettingsCard from "./console-settings-card.vue";
import Icon from "./console-icon.vue";

const { pageOrigin } = useConsoleProjects();
const toast = useConsoleToast();
const mcpUrl = `${pageOrigin}/mcp/account`;
const prompt = `Connect T3 Code to my ViteHub Console. Add the MCP server ${mcpUrl} (HTTP, sign in with OAuth when it asks), then call whoami.`;

const connections = shallowRef<ConsoleMcpConnection[]>();
const loadProblem = ref(false);
const revoking = ref<ConsoleMcpConnection>();
const revokeBusy = ref(false);
const connected = computed(() => Boolean(connections.value?.length));

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

async function load(): Promise<void> {
  try {
    connections.value = await listConsoleMcpConnections();
    loadProblem.value = false;
  }
  catch {
    loadProblem.value = true;
  }
}

onMounted(load);

function label(connection: ConsoleMcpConnection | undefined): string {
  return connection?.name || "MCP client";
}

function detail(connection: ConsoleMcpConnection): string {
  const used = connection.lastUsedAt ?? connection.connectedAt;
  return used ? `Connected · Last used ${dateFormat.format(new Date(used))}` : "Connected";
}

function copyFailed(): void {
  toast.show({ title: "The browser blocked the clipboard. Select the prompt and copy it." });
}

async function revoke(): Promise<void> {
  const connection = revoking.value;
  if (!connection || revokeBusy.value) return;
  revokeBusy.value = true;
  try {
    await revokeConsoleMcpConnection(connection.clientId);
    toast.show({ title: `${label(connection)} disconnected` });
    revoking.value = undefined;
    await load();
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "The client was not disconnected. Try again." });
  }
  revokeBusy.value = false;
}
</script>

<template>
  <ConsoleSettingsCard title="T3 Code" description="Your agents read, answer and resolve comments on every app and site in your teams." heading-id="vitehub-settings-t3-code">
    <ul v-if="!connections && !loadProblem" class="vitehub-account-list" aria-hidden="true">
      <li class="vitehub-account-list__row">
        <USkeleton class="vitehub-account-icon shrink-0" />
        <span class="grid flex-1 gap-1.5 py-0.5">
          <USkeleton class="h-3.5 w-24" />
          <USkeleton class="h-3 w-56" />
        </span>
      </li>
    </ul>
    <ul v-else-if="connected" class="vitehub-account-list">
      <li v-for="connection in connections" :key="connection.clientId" class="vitehub-account-list__row">
        <Icon name="i-lucide-plug" class="vitehub-account-icon shrink-0 text-muted" aria-hidden="true" />
        <span class="grid min-w-0 flex-1">
          <span class="truncate text-sm font-medium text-highlighted">{{ label(connection) }}</span>
          <span class="truncate text-xs text-muted">{{ detail(connection) }}</span>
        </span>
        <UButton size="xs" color="neutral" variant="ghost" label="Disconnect" :aria-label="`Disconnect ${label(connection)}`" @click="revoking = connection" />
      </li>
    </ul>
    <div v-else-if="connections" class="grid gap-2">
      <CodeBlock size="sm">
        <CodeBlockHeader>
          <CodeBlockTitle>Prompt</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton :value="prompt" aria-label="Copy the prompt" color="neutral" @error="copyFailed" />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent wrap class="text-[13px] text-highlighted">{{ prompt }}</CodeBlockContent>
      </CodeBlock>
      <p class="text-sm text-muted">Paste it in any T3 Code thread.</p>
    </div>
    <div v-if="loadProblem" role="alert" class="flex items-center gap-2 text-[13px] text-error">
      The MCP connections did not load.
      <UButton size="xs" color="neutral" variant="ghost" label="Retry" @click="load()" />
    </div>
    <template #footer>Uses the ViteHub MCP at <code class="font-mono">{{ mcpUrl }}</code>.</template>
    <template v-if="connections && !connected" #action>
      <CopyButton :value="prompt" size="sm" color="neutral" variant="outline" label="Copy prompt" @error="copyFailed" />
    </template>

    <UModal
      :open="revoking !== undefined"
      :title="`Disconnect ${label(revoking)}?`"
      description="Its agents lose access to the ViteHub MCP. To connect again, use the prompt."
      :dismissible="!revokeBusy"
      :ui="{ content: 'sm:max-w-[440px]' }"
      @update:open="(value: boolean) => { if (!value) revoking = undefined; }"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="revokeBusy" @click="revoking = undefined" />
          <UButton color="error" label="Disconnect" :loading="revokeBusy" @click="revoke" />
        </div>
      </template>
    </UModal>
  </ConsoleSettingsCard>
</template>
