<script setup lang="ts">
import { Status } from "@vite-hub/ui";
import { computed } from "vue";
import { useRoute } from "vue-router";

import { consoleDocumentStateColor, consoleDocumentStateLabel, consoleErrorMessage } from "../client/documents";
import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionRouteName } from "../sections";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";

import type { ConsoleDocumentOverview, ConsoleDocumentState } from "../client/documents";
import type { ConsoleDocumentCollection } from "../definitions";
import ConsoleSection from "./console-section.vue";

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

  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <UEmpty
      v-if="!error && !firstLoad && !singletons.length"
      class="flex-1"
      variant="naked"
      icon="i-lucide-settings-2"
      title="No singletons"
      description="Define a singleton() in server/content.ts, such as settings.json, to edit it here."
    />
    <div v-else class="vitehub-console-page grid gap-2">
      <UAlert
        v-if="error"
        color="error"
        icon="i-lucide-cloud-off"
        title="Couldn't load singletons"
        :description="consoleErrorMessage(error)"
        :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', variant: 'outline', onClick: () => emit('reload') }]"
      />
      <div v-else-if="firstLoad" class="grid gap-px">
        <USkeleton v-for="index in 2" :key="index" class="h-14" />
      </div>
      <ConsoleSection v-else title="Singletons" :count="singletons.length" description="Each is one document at a fixed path. It saves as a draft and publishes like any other document.">
        <!-- The list does not clip its rows, so the focus ring around a row stays visible. The end rows take its corners. -->
        <ul class="divide-y divide-default rounded-lg border border-default" aria-label="Settings">
          <li v-for="singleton in singletons" :key="singleton.name" class="first:*:rounded-t-md last:*:rounded-b-md">
            <RouterLink
              :to="editorRoute(singleton.name)"
              class="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-elevated"
            >
              <span class="grid min-w-0 flex-1">
                <span class="truncate text-sm font-medium text-highlighted">{{ singleton.label }}</span>
                <span class="truncate font-mono text-xs text-dimmed">{{ singleton.path }}</span>
              </span>
              <span v-if="!singleton.access.write" class="shrink-0 text-xs text-dimmed">Read-only</span>
              <Status
                v-if="stateOf(singleton.name)"
                class="shrink-0"
                :tone="consoleDocumentStateColor(stateOf(singleton.name)!)"
                :label="consoleDocumentStateLabel(stateOf(singleton.name)!)"
              />
              <Status v-else-if="overview" class="shrink-0" tone="neutral" label="Not created" />
              <span v-if="updatedAt(singleton.name)" class="hidden w-16 shrink-0 whitespace-nowrap text-right text-xs text-muted sm:inline">
                <ConsoleRelativeTime :value="updatedAt(singleton.name)!" />
              </span>
              <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
            </RouterLink>
          </li>
        </ul>
      </ConsoleSection>
    </div>
  </div>
</template>
