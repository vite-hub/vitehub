<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";

import { consoleDocumentStateColor, consoleDocumentStateLabel, consoleErrorMessage } from "../client/documents";
import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionRouteName } from "../sections";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleStatus from "./console-status.vue";

import type { ConsoleDocumentOverview, ConsoleDocumentState } from "../client/documents";
import type { ConsoleDocumentCollection } from "../definitions";

/**
 * The Settings page of a document editor section: one row per singleton, such as site settings or a home page, that
 * opens it in the editor. The state comes from the overview the section shell already loads.
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
  <ConsolePageHeader :title="label" />

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto grid max-w-5xl gap-2 px-4 py-6 sm:px-6">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-cloud-off"
        title="Couldn't load singletons"
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
        title="No singletons"
        description="Define a singleton() in server/content.ts, such as settings.json, to edit it here."
      />
      <template v-else>
        <h2 class="text-[13px] font-medium text-highlighted">
          Singletons
          <span class="ms-1 font-normal text-dimmed tabular-nums">{{ singletons.length }}</span>
        </h2>
        <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default" aria-label="Settings">
          <li v-for="singleton in singletons" :key="singleton.name">
            <RouterLink
              :to="editorRoute(singleton.name)"
              class="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-elevated/60 focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
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
              <ConsoleStatus v-else-if="overview" class="shrink-0" tone="neutral" label="Not created" />
              <span v-if="updatedAt(singleton.name)" class="hidden w-16 shrink-0 whitespace-nowrap text-right text-xs text-muted sm:inline">
                <ConsoleRelativeTime :value="updatedAt(singleton.name)!" />
              </span>
              <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
            </RouterLink>
          </li>
        </ul>
        <p class="text-xs text-dimmed">Each is one document at a fixed path. It saves as a draft and publishes like any other document.</p>
      </template>
    </div>
  </div>
</template>
