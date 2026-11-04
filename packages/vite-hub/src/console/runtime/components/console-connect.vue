<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from "vue";

import type { ConsoleNavigation } from "../client/sections";
import { loadConsoleNavigation, resolveConsoleSectionDetails, subscribeConsoleNavigation } from "../client/sections";
import { consoleDocsBase } from "../sections";
import ConsoleConnectAgent from "./console-connect-agent.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleSectionIcon from "./console-section-icon.vue";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const navigation = shallowRef<ConsoleNavigation>();
const host = typeof window === "undefined" ? "" : window.location.host;
// The sections that tools/list offers to this person: the same ones as the rail.
const sections = computed(() =>
  (navigation.value?.sections ?? []).flatMap((section) => {
    const details = resolveConsoleSectionDetails(navigation.value, section);
    return details ? [{ id: section, ...details, readOnly: navigation.value?.readOnly.includes(section) ?? false }] : [];
  }),
);
const steps = computed(() => {
  if (navigation.value?.auth === "cloudflare-access") {
    return [
      "Create a service token in Cloudflare Access and allow it in this application’s Service Auth policy.",
      "Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the shell that starts your agent.",
      "Add the server with the command for your agent. Every tool call sends the token.",
    ];
  }
  if (navigation.value?.auth === false) {
    return [
      "Add the server with the command for your agent.",
      "This Console has no sign-in. Development access is loopback-only; in production, anyone who can reach it can use it unless console.authorize restricts access.",
    ];
  }
  return [
    "Add the server with the command for your agent.",
    `Your agent opens a sign-in page on ${host}. Sign in there as yourself.`,
    "Allow the agent. It then acts as you, with the sections below.",
  ];
});

let unsubscribe: (() => void) | undefined;
onMounted(async () => {
  unsubscribe = subscribeConsoleNavigation(props.sectionsBase, (result) => {
    navigation.value = result;
  });
  const result = await loadConsoleNavigation(props.sectionsBase);
  if (result) navigation.value = result;
});
onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
  <ConsoleSearch :agents-base="agentsBase" :definitions-base="definitionsBase" :kv-base="kvBase" :search-base="searchBase" :sections-base="sectionsBase" />
  <UDashboardPanel id="console-connect" :ui="{ body: 'min-h-0 overflow-y-auto p-0 sm:p-0 gap-0' }">
    <template #header>
      <ConsolePageHeader title="Connect an agent" :toggle="false">
        <template #right>
          <UButton
            label="MCP guide"
            :to="`${consoleDocsBase}/development/mcp`"
            target="_blank"
            rel="noopener noreferrer"
            icon="i-lucide-arrow-up-right"
            :ui="{ label: 'hidden sm:inline' }"
            size="sm"
            color="neutral"
            variant="ghost"
            aria-label="Open the MCP guide"
          />
        </template>
      </ConsolePageHeader>
    </template>

    <template #body>
      <main class="px-5 pb-24 pt-8 sm:px-8 lg:pt-12">
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-10">
          <header class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-x-6">
            <span class="grid size-10 place-items-center rounded-full border border-default text-highlighted">
              <UIcon name="i-lucide-bot" class="size-[1.125rem]" />
            </span>
            <div class="min-w-0">
              <h1 class="text-base font-semibold tracking-tight text-highlighted">Use this Console from your agent</h1>
              <p class="text-sm text-pretty text-muted">Claude Code, Codex, Cursor, and other MCP clients run this app’s operations as tools.</p>
            </div>
          </header>

          <section class="vitehub-console__connect-block" aria-labelledby="console-connect-add">
            <h2 id="console-connect-add" class="vitehub-console__connect-label">Add the server</h2>
            <ConsoleConnectAgent v-if="navigation" :auth="navigation.auth" />
            <USkeleton v-else class="h-48 rounded-lg" />
          </section>

          <section class="vitehub-console__connect-block" aria-labelledby="console-connect-sign-in">
            <h2 id="console-connect-sign-in" class="vitehub-console__connect-label">Sign in</h2>
            <ol class="grid gap-3 sm:pt-2.5">
              <li v-for="(step, index) in steps" :key="step" class="flex gap-3 text-sm">
                <span class="grid size-5 shrink-0 place-items-center rounded-full border border-default font-mono text-[11px] text-muted" aria-hidden="true">{{ index + 1 }}</span>
                <span class="text-pretty">{{ step }}</span>
              </li>
            </ol>
          </section>

          <section class="vitehub-console__connect-block" aria-labelledby="console-connect-access">
            <h2 id="console-connect-access" class="vitehub-console__connect-label">What it can use</h2>
            <div class="sm:pt-2.5">
              <p class="text-sm text-pretty text-muted">The tools of the sections you may use. Tools that delete or publish are marked as destructive, and the server asks the agent to tell you before it runs one.</p>
              <ul v-if="sections.length" class="mt-3 grid overflow-hidden rounded-lg border border-default sm:grid-cols-2">
                <li v-for="section in sections" :key="section.id" class="vitehub-console__connect-section flex min-w-0 items-center gap-2.5 px-3 py-2 text-sm">
                  <ConsoleSectionIcon :icon="section.icon" class="size-4 shrink-0 text-muted" />
                  <span class="truncate font-medium text-highlighted">{{ section.label }}</span>
                  <span v-if="section.readOnly" class="ms-auto shrink-0 text-xs text-muted">Read only</span>
                </li>
              </ul>
              <USkeleton v-else-if="!navigation" class="mt-3 h-20 rounded-lg" />
            </div>
          </section>
        </div>
      </main>
    </template>
  </UDashboardPanel>
</template>

<style>
/* Each block puts its label in a narrow left column, like the Overview. Blocks stack on narrow screens. */
.vitehub-console__connect-block {
  display: grid;
  gap: 0.5rem 1.5rem;
}

@media (min-width: 40rem) {
  .vitehub-console__connect-block {
    grid-template-columns: 7rem minmax(0, 1fr);
  }
}

/* Each cell draws its right and bottom hairline. The list clips the ones on its edge, so an odd count leaves no hole. */
.vitehub-console__connect-section {
  box-shadow: 1px 0 0 var(--ui-border), 0 1px 0 var(--ui-border);
}

.vitehub-console__connect-label {
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.25rem;
}

@media (min-width: 40rem) {
  .vitehub-console__connect-label {
    line-height: 2.5rem;
  }
}
</style>
