<script setup lang="ts">
import { computed, ref } from "vue";

import type { ConsoleNavigation } from "../client/sections";

import { consoleMcpCommands } from "../client/mcp";

const props = defineProps<{ auth: ConsoleNavigation["auth"] }>();

const origin = typeof window === "undefined" ? "" : window.location.origin;
// The page may sit under an application mount, such as `/portal/_vitehub`.
const mount = typeof window === "undefined" ? "" : window.location.pathname.slice(0, window.location.pathname.lastIndexOf("/_vitehub"));
const url = computed(() => `${origin}${mount}/_vitehub/mcp`);
const commands = computed(() => consoleMcpCommands(url.value, props.auth));
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
</script>

<template>
  <section class="mt-12" aria-labelledby="console-home-connect-agent">
    <h2 id="console-home-connect-agent" class="vitehub-console__overview-eyebrow">
      <span>Connect an agent</span>
    </h2>
    <p class="mb-4 max-w-2xl text-[13px]/[18px] text-muted">
      <template v-if="auth === 'cloudflare-access'">
        Create a Cloudflare Access service token and allow it in this application’s Service Auth policy. Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in your shell before running Claude Code’s command or starting Codex. Claude Code saves the expanded headers in its MCP configuration.
      </template>
      <template v-else>Agents use the same operations as this Console and the CLI, as the person who signs in. They see only the sections you may use.</template>
    </p>
    <div class="grid gap-px overflow-hidden rounded-lg border border-default sm:grid-cols-2">
      <div v-for="command in commands" :key="command.label" class="flex flex-col gap-2 p-4">
        <span class="flex items-center justify-between gap-3">
          <span class="text-sm font-medium text-highlighted">{{ command.label }}</span>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            :icon="copied === command.label ? 'i-lucide-check' : 'i-lucide-copy'"
            :aria-label="`Copy the ${command.label} command`"
            @click="copy(command.label, command.text)"
          />
        </span>
        <pre class="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-elevated p-3 text-xs"><code>{{ command.text }}</code></pre>
      </div>
    </div>
  </section>
</template>
