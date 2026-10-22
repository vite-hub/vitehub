<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";

import { consoleDocumentStateColor, consoleDocumentStateLabel, consoleErrorMessage } from "../client/documents";
import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionRouteName } from "../sections";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleStatus from "./console-status.vue";

import type { ConsoleDocumentOverview, ConsoleDocumentState } from "../client/documents";
import type { ConsoleDocumentCollection } from "../definitions";

/**
 * The Settings page of a document editor section: one row per singleton, such as site settings, that opens it in the
 * editor. The state comes from the overview the section shell already loads.
 */
const props = defineProps<{
  error?: unknown;
  label: string;
  loading: boolean;
  overview?: ConsoleDocumentOverview;
  section: string;
  /** The singletons of the section that the user may read. */
  singletons: readonly ConsoleDocumentCollection[];
}>();

const emit = defineEmits<{ reload: [] }>();

const route = useRoute();
const firstLoad = computed(() => props.loading && !props.singletons.length);

/** The state of the one document of a singleton, or undefined before its first save. */
function stateOf(name: string): ConsoleDocumentState | undefined {
  const states = props.overview?.collections.find(entry => entry.name === name)?.states;
  if (!states) return undefined;
  return (["deleted", "changed", "draft", "published"] as const).find(state => states[state] > 0);
}

function updatedAt(name: string): string | undefined {
  return props.overview?.collections.find(entry => entry.name === name)?.changes[0]?.updatedAt ?? undefined;
}

function editorRoute(name: string) {
  return { name: resolveConsoleRouteName(route.name, consoleSectionRouteName(props.section)), params: { collection: name, document: [] }, query: {} };
}
</script>

<template>
  <UDashboardNavbar :ui="{ root: 'border-b border-default' }" :toggle="{ 'aria-label': 'Open section navigation' }">
    <template #title>
      <span class="truncate text-sm font-medium text-highlighted">{{ label }}</span>
    </template>
  </UDashboardNavbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto grid w-full max-w-3xl gap-6 px-6 py-8">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-cloud-off"
        title="Couldn't load settings"
        :description="consoleErrorMessage(error)"
        :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: () => emit('reload') }]"
      />
      <div v-else-if="firstLoad" class="grid gap-px">
        <USkeleton v-for="index in 2" :key="index" class="h-14 rounded-md" />
      </div>
      <UEmpty
        v-else-if="!singletons.length"
        variant="naked"
        icon="i-lucide-settings-2"
        title="No settings"
        description="Define a singleton() in server/content.ts, such as settings.json, to edit site settings here."
      />
      <ul v-else class="divide-y divide-default overflow-hidden rounded-lg border border-default" aria-label="Settings">
        <li v-for="singleton in singletons" :key="singleton.name">
          <RouterLink
            :to="editorRoute(singleton.name)"
            class="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-elevated/50 focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <UIcon name="i-lucide-settings-2" class="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span class="grid min-w-0 flex-1">
              <span class="truncate text-sm font-medium text-highlighted">{{ singleton.label }}</span>
              <span class="truncate font-mono text-xs text-dimmed">{{ singleton.path }}</span>
            </span>
            <span v-if="!singleton.access.write" class="shrink-0 text-xs text-dimmed">Read-only</span>
            <ConsoleStatus
              v-if="stateOf(singleton.name)"
              class="shrink-0"
              :tone="consoleDocumentStateColor(stateOf(singleton.name)!)"
              :label="consoleDocumentStateLabel(stateOf(singleton.name)!)"
            />
            <span v-else-if="overview" class="shrink-0 text-xs text-muted">Not created</span>
            <span class="hidden w-16 shrink-0 whitespace-nowrap text-right text-xs text-muted sm:inline">
              <ConsoleRelativeTime v-if="updatedAt(singleton.name)" :value="updatedAt(singleton.name)!" />
            </span>
          </RouterLink>
        </li>
      </ul>
    </div>
  </div>
</template>
