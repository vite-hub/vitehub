<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleSectionId } from "../sections";
import { resolveConsoleRouteName } from "../console-route";
import {
  consoleSectionDetails,
  isConsoleSectionId,
  prioritizeConsoleSectionIds,
  readLastConsoleSection,
} from "../sections";
import { requestConsole } from "../client/request";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSearch from "./console-search.vue";

const props = defineProps<{
  agentsBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
const sections = ref<ConsoleSectionId[]>([]);
const lastSection = ref<ConsoleSectionId>();
const loading = ref(true);
const error = ref<unknown>();
let request: AbortController | undefined;

const availableSections = computed(() =>
  prioritizeConsoleSectionIds(sections.value, lastSection.value).map((section) => ({
    id: section,
    lastOpened: section === lastSection.value,
    ...consoleSectionDetails[section],
  })),
);

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "The console could not load its configuration.";
}

async function loadSections(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  try {
    const value = record(await requestConsole(props.sectionsBase, { signal: controller.signal }));
    const installed = Array.isArray(value?.sections)
      ? value.sections.filter(isConsoleSectionId)
      : [];
    if (request === controller) {
      sections.value = [...new Set(installed)];
      error.value = undefined;
    }
  } catch (requestError) {
    if (
      requestError instanceof Object &&
      "name" in requestError &&
      requestError.name === "AbortError"
    )
      return;
    if (request === controller) error.value = requestError;
  } finally {
    if (request === controller) {
      request = undefined;
      loading.value = false;
    }
  }
}

async function openSection(routeName: string): Promise<void> {
  sidebarOpen.value = false;
  await router.push({ name: resolveConsoleRouteName(route.name, routeName) });
}

onMounted(() => {
  lastSection.value = readLastConsoleSection();
  void loadSections();
});
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="console-sections"
      v-model:open="sidebarOpen"
      v-model:collapsed="sidebarCollapsed"
      :default-size="19"
      :collapsed-size="4"
      :min-size="16"
      :max-size="24"
      :menu="{ title: 'ViteHub Console', description: 'Choose a configured section.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'border-t border-default px-3 py-2' }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <div class="flex h-10 w-full min-w-0 items-center gap-2.5 px-1.5">
          <ConsoleMark />
          <span v-if="!collapsed" class="grid min-w-0 flex-1 leading-none">
            <small class="truncate text-[10px] font-bold uppercase tracking-[.12em] text-muted">
              ViteHub Console
            </small>
            <strong class="mt-1 truncate text-sm font-semibold text-highlighted">Sections</strong>
          </span>
        </div>
      </template>

      <template #default="{ collapsed }">
        <div v-if="!collapsed" class="px-4 pb-3 pt-5">
          <span class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
            Configured
          </span>
          <h1 class="mt-1 text-lg font-semibold tracking-tight text-highlighted">Explore</h1>
        </div>
        <div v-if="error && !collapsed" class="px-3 pb-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Could not load sections"
            :description="errorMessage(error)"
            :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: loadSections }]"
          />
        </div>
        <div v-if="loading" class="grid gap-2 px-2" :class="collapsed ? 'pt-2' : ''">
          <USkeleton v-for="index in 2" :key="index" :class="collapsed ? 'h-9' : 'h-14'" />
        </div>
        <nav
          v-else-if="availableSections.length"
          class="grid gap-1 px-2"
          :class="collapsed ? 'pt-2' : ''"
        >
          <div class="pb-2">
            <UDashboardSearchButton
              :collapsed="collapsed"
              block
              class="w-full bg-transparent ring-default"
              label="Search console"
            />
          </div>
          <UTooltip
            v-for="section in availableSections"
            :key="section.id"
            :text="section.label"
            :disabled="!collapsed"
            :content="{ side: 'right' }"
          >
            <UButton
              block
              class="justify-start"
              color="neutral"
              :icon="section.icon"
              :label="collapsed ? undefined : section.label"
              :aria-label="collapsed ? section.label : undefined"
              variant="ghost"
              @click="openSection(section.routeName)"
            />
          </UTooltip>
        </nav>
        <p v-else-if="!collapsed && !error" class="px-4 text-sm leading-6 text-muted">
          Enable Agents, KV, Workflow, Queue, or Schedule in the ViteHub configuration to add a section.
        </p>
      </template>

      <template #footer="{ collapsed, collapse }">
        <span v-if="!collapsed" class="flex items-center gap-1.5 text-xs text-muted">
          <UIcon name="i-lucide-lock-keyhole" class="size-3.5" />Read-only
        </span>
        <UButton
          class="ml-auto max-lg:hidden"
          :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="collapsed ? 'Show sections' : 'Hide sections'"
          @click="collapse(!collapsed)"
        />
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agents-base="agentsBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="console-home">
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex h-14 shrink-0 items-center border-b border-default px-4 lg:hidden">
          <UButton
            aria-label="Open sections"
            color="neutral"
            icon="i-lucide-panel-left"
            variant="ghost"
            @click="sidebarOpen = true"
          />
          <span class="ml-2 text-sm font-semibold text-highlighted">ViteHub Console</span>
        </div>
        <main class="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8 sm:py-10 lg:px-12">
          <div class="mx-auto w-full max-w-5xl">
            <div class="max-w-2xl">
              <span class="text-xs font-semibold uppercase tracking-[.12em] text-muted">
                ViteHub Console
              </span>
              <h1 class="mt-2 text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl">
                Choose a primitive
              </h1>
              <p class="mt-3 text-sm leading-6 text-muted sm:text-base">
                Inspect the server primitives enabled for this project. Console access is read-only.
              </p>
            </div>

            <div v-if="loading" class="mt-8 grid gap-3 sm:grid-cols-2">
              <USkeleton v-for="index in 2" :key="index" class="h-48 rounded-xl" />
            </div>
            <div
              v-else-if="availableSections.length"
              class="mt-8 grid gap-3"
              :class="availableSections.length > 1 ? 'sm:grid-cols-2' : 'max-w-lg'"
            >
              <button
                v-for="section in availableSections"
                :key="section.id"
                type="button"
                class="group flex min-h-48 flex-col rounded-xl border border-default bg-default p-5 text-start shadow-xs transition hover:border-accented hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                :aria-label="`Open ${section.label}`"
                @click="openSection(section.routeName)"
              >
                <div class="flex items-start justify-between gap-4">
                  <span class="flex size-10 items-center justify-center rounded-lg bg-elevated ring-1 ring-default">
                    <UIcon :name="section.icon" class="size-5 text-highlighted" />
                  </span>
                  <UBadge
                    v-if="section.lastOpened"
                    color="neutral"
                    label="Last opened"
                    size="sm"
                    variant="soft"
                  />
                </div>
                <div class="mt-6">
                  <h2 class="text-base font-semibold text-highlighted">{{ section.label }}</h2>
                  <p class="mt-1.5 text-sm leading-6 text-muted">{{ section.description }}</p>
                </div>
                <span class="mt-auto flex items-center gap-1.5 pt-5 text-sm font-medium text-toned">
                  Open {{ section.label }}
                  <UIcon
                    name="i-lucide-arrow-right"
                    class="size-4 transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </button>
            </div>
            <UAlert
              v-else-if="error"
              class="mt-8"
              color="error"
              variant="subtle"
              icon="i-lucide-cloud-off"
              title="Could not load sections"
              :description="errorMessage(error)"
              :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: loadSections }]"
            />
            <UEmpty
              v-else
              class="mt-8 min-h-72 rounded-xl border border-dashed border-default"
              icon="i-lucide-panels-top-left"
              title="No primitives enabled"
              description="Enable Agents, KV, Workflow, Queue, or Schedule in the ViteHub configuration to add a Console page."
            />
          </div>
        </main>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
