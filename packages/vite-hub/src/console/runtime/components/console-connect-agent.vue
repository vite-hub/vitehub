<script setup lang="ts">
import { computed, ref, useId } from "vue";

import type { ConsoleNavigation } from "../client/sections";

import { consoleMcpCommands } from "../client/mcp";

const props = defineProps<{ auth: ConsoleNavigation["auth"] }>();

const origin = typeof window === "undefined" ? "" : window.location.origin;
// The page may sit under an application mount, such as `/portal/_vitehub`.
const mount = typeof window === "undefined" ? "" : window.location.pathname.slice(0, window.location.pathname.lastIndexOf("/_vitehub"));
const url = computed(() => `${origin}${mount}/_vitehub/mcp`);
const commands = computed(() => consoleMcpCommands(url.value, props.auth));
const selected = ref(0);
const current = computed(() => commands.value[Math.min(selected.value, commands.value.length - 1)]);
const id = useId();
const copied = ref<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy(label: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = label;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = undefined), 1500);
  }
  catch {
    // The text stays on the page to select by hand.
  }
}

// Arrow keys move between the client tabs, as in a WAI-ARIA tab list.
function move(event: KeyboardEvent, index: number) {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  selected.value = (index + step + commands.value.length) % commands.value.length;
  const tabs = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>("[role=tab]");
  tabs?.[selected.value]?.focus();
}
</script>

<template>
  <div class="grid gap-4">
    <p class="max-w-2xl text-sm text-pretty text-muted">
      <template v-if="auth === 'cloudflare-access'">
        Create a Cloudflare Access service token and allow it in this application’s Service Auth policy. Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in your shell before you run Claude Code’s command or start Codex. Claude Code saves the expanded headers in its MCP configuration.
      </template>
      <template v-else>Agents use the same operations as this Console and the CLI, as the person who signs in. They see only the sections you may use.</template>
    </p>

    <div class="overflow-hidden rounded-lg border border-default">
      <div class="flex items-center gap-3 border-b border-default px-3 py-2">
        <span class="shrink-0 text-xs text-muted">Server URL</span>
        <code class="min-w-0 flex-1 truncate font-mono text-xs text-highlighted" :title="url">{{ url }}</code>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          :icon="copied === 'url' ? 'i-lucide-check' : 'i-lucide-copy'"
          aria-label="Copy the server URL"
          @click="copy('url', url)"
        />
      </div>

      <div role="tablist" aria-label="Agent" class="flex gap-1 overflow-x-auto border-b border-default px-2 pt-2">
        <button
          v-for="(command, index) in commands"
          :id="`${id}-tab-${index}`"
          :key="command.label"
          type="button"
          role="tab"
          class="vitehub-console__connect-tab"
          :aria-selected="command === current"
          :aria-controls="`${id}-panel-${index}`"
          :tabindex="command === current ? 0 : -1"
          @click="selected = index"
          @keydown="move($event, index)"
        >
          {{ command.label }}
        </button>
      </div>

      <div
        v-for="(command, index) in commands"
        :id="`${id}-panel-${index}`"
        :key="command.label"
        role="tabpanel"
        :aria-labelledby="`${id}-tab-${index}`"
        :hidden="command !== current"
        class="grid gap-2 p-3"
      >
        <span class="flex items-center justify-between gap-3">
          <span class="font-mono text-xs text-muted">{{ command.where }}</span>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            :icon="copied === command.label ? 'i-lucide-check' : 'i-lucide-copy'"
            :aria-label="`Copy the ${command.label} ${command.where === 'Terminal' ? 'command' : 'configuration'}`"
            @click="copy(command.label, command.text)"
          />
        </span>
        <pre class="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-elevated p-3 text-xs"><code>{{ command.text }}</code></pre>
      </div>
    </div>
  </div>
</template>

<style>
.vitehub-console__connect-tab {
  border-bottom: 2px solid transparent;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  font-weight: 500;
  margin-bottom: -1px;
  padding: 0.25rem 0.5rem 0.5rem;
  white-space: nowrap;
}

.vitehub-console__connect-tab:hover {
  color: var(--ui-text);
}

.vitehub-console__connect-tab[aria-selected="true"] {
  border-bottom-color: var(--ui-text-highlighted);
  color: var(--ui-text-highlighted);
}

.vitehub-console__connect-tab:focus-visible {
  border-radius: 0.25rem;
  outline: 2px solid var(--ui-border-inverted);
}
</style>
