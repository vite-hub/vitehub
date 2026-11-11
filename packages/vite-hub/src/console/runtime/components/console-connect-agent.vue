<script setup lang="ts">
import { CopyButton } from "@vite-hub/ui";
import { computed, ref } from "vue";

import type { ConsoleNavigation } from "../client/sections";

import { consoleMcpCommands } from "../client/mcp";
import { projectUrl } from "../client/project";

const props = defineProps<{ auth: ConsoleNavigation["auth"] }>();

const url = computed(() => (typeof window === "undefined" ? "" : new URL(projectUrl("/_vitehub/mcp"), window.location.href).href));
const commands = computed(() => consoleMcpCommands(url.value, props.auth));
// The tab of each client is its label. When the auth mode removes a client, the first one shows.
const items = computed(() => commands.value.map(command => ({ label: command.label, value: command.label, command })));
const chosen = ref<string>();
const selected = computed({
  get: () => commands.value.find(command => command.label === chosen.value)?.label ?? commands.value[0]?.label,
  set: (value: string | number | undefined) => { chosen.value = value === undefined ? undefined : String(value); },
});
</script>

<template>
  <div class="grid gap-4">
    <p class="max-w-2xl text-sm text-pretty text-muted">
      <template v-if="auth === 'cloudflare-access'">
        Create a Cloudflare Access service token and allow it in this application’s Service Auth policy. Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in your shell before you run Claude Code’s command or start Codex. Claude Code saves the expanded headers in its MCP configuration.
      </template>
      <template v-else>Agents use the same operations as this Console and the CLI, as the person who signs in. They see only the sections you may use.</template>
    </p>

    <div class="rounded-lg border border-default">
      <div class="flex items-center gap-3 border-b border-default px-3 py-2">
        <span class="shrink-0 text-xs text-muted">Server URL</span>
        <code class="min-w-0 flex-1 truncate font-mono text-xs text-highlighted" :title="url">{{ url }}</code>
        <CopyButton :value="url" size="xs" aria-label="Copy the server URL" />
      </div>

      <UTabs v-model="selected" :items="items" aria-label="Agent" class="gap-0">
        <template #content="{ item }">
          <div class="grid gap-2 p-3">
            <span class="flex items-center justify-between gap-3">
              <span class="font-mono text-xs text-muted">{{ item.command.where }}</span>
              <CopyButton
                :value="item.command.text"
                size="xs"
                :aria-label="`Copy the ${item.command.label} ${item.command.where === 'Terminal' ? 'command' : 'configuration'}`"
              />
            </span>
            <pre class="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-elevated p-3 text-xs"><code>{{ item.command.text }}</code></pre>
          </div>
        </template>
      </UTabs>
    </div>
  </div>
</template>
