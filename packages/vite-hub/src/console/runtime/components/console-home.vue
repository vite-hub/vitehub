<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleSectionId } from "../sections";
import { resolveConsoleRouteName } from "../console-route";
import {
  consoleSectionDetails,
  prioritizeConsoleSectionIds,
  readLastConsoleSection,
} from "../sections";
import { loadConsoleNavigation } from "../client/sections";
import ConsoleBrand from "./console-brand.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleSearch from "./console-search.vue";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const sections = ref<ConsoleSectionId[]>([]);
const lastSection = ref<ConsoleSectionId>();
const loading = ref(true);
const error = ref<unknown>();
let request = 0;

const availableSections = computed(() =>
  prioritizeConsoleSectionIds(sections.value, lastSection.value).map((section) => ({
    id: section,
    ...consoleSectionDetails[section],
  })),
);
const sidebarSections = computed(() =>
  availableSections.value.filter((section) => section.id !== "usage"),
);

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "The console could not load its configuration.";
}

async function loadSections(): Promise<void> {
  const currentRequest = ++request;
  loading.value = true;
  try {
    const navigation = await loadConsoleNavigation(props.sectionsBase);
    if (!navigation) throw viteHubErrorDiagnostics.VITE_HUB_R0101({ message: "The console could not load its configuration." });
    if (request !== currentRequest) return;
    sections.value = [...new Set(navigation.sections)];
    error.value = undefined;
  } catch (requestError) {
    if (request === currentRequest) error.value = requestError;
  } finally {
    if (request === currentRequest) loading.value = false;
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
onBeforeUnmount(() => request++);
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="console-navigation"
      v-model:open="sidebarOpen"
      :default-size="16"
      :collapsed-size="4"
      :min-size="13"
      :max-size="26"
      :menu="{ title: 'ViteHub', description: 'Choose a section.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'h-11 shrink-0 border-t border-default px-2 py-1.5' }"
      resizable
    >
      <template #header="{ collapsed }">
        <ConsoleBrand :collapsed="collapsed" :sections-base="sectionsBase" />
      </template>

      <template #default="{ collapsed }">
        <div v-if="error && !collapsed" class="px-3 pb-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-ph-cloud-slash-light"
            title="Could not load sections"
            :description="errorMessage(error)"
            :actions="[
              { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: loadSections },
            ]"
          />
        </div>
        <div v-if="loading" class="grid gap-2 px-2" :class="collapsed ? 'pt-2' : ''">
          <USkeleton v-for="index in 2" :key="index" :class="collapsed ? 'h-9' : 'h-14'" />
        </div>
        <nav
          v-else-if="sidebarSections.length"
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
            v-for="section in sidebarSections"
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
          Enable Agents, Blob, Database, KV, Rate Limit, Sandbox, Workspace, Workflow, Queue, or Schedule in the ViteHub configuration to add a section.
        </p>
      </template>

      <template #footer="{ collapsed }">
        <ConsolePrimitiveSwitcher :collapsed="collapsed" :sections-base="sectionsBase" />
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="console-home" :ui="{ body: 'min-h-0 overflow-y-auto p-0 gap-0' }">
      <template #header>
        <UDashboardNavbar title="Overview" :ui="{ root: 'border-b border-default' }" />
      </template>

      <template #body>
        <main class="px-5 py-8 sm:px-8 lg:px-12">
          <div class="mx-auto w-full max-w-5xl">
            <UPageHeader
              class="max-w-2xl border-0 p-0"
              title="Primitives"
              description="Inspect the server features enabled for this project."
            />

            <div v-if="loading" class="mt-8 grid gap-3 sm:grid-cols-2">
              <USkeleton v-for="index in 4" :key="index" class="h-28 rounded-xl" />
            </div>
            <UPageGrid
              v-else-if="availableSections.length"
              class="mt-8 gap-3"
              :class="availableSections.length > 1 ? 'sm:grid-cols-2 lg:grid-cols-2' : 'max-w-lg'"
            >
              <UPageCard
                v-for="section in availableSections"
                :key="section.id"
                :icon="section.icon"
                :title="section.label"
                :description="section.description"
                :ui="{ root: 'cursor-pointer text-left', container: 'p-5 sm:p-5', leadingIcon: 'size-5' }"
                as="button"
                type="button"
                variant="subtle"
                :aria-label="`Open ${section.label}`"
                @click="openSection(section.routeName)"
              />
            </UPageGrid>
            <UAlert
              v-else-if="error"
              class="mt-8"
              color="error"
              variant="subtle"
              icon="i-ph-cloud-slash-light"
              title="Could not load sections"
              :description="errorMessage(error)"
              :actions="[
                { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: loadSections },
              ]"
            />
            <UEmpty
              v-else
              class="mt-8 min-h-72 rounded-xl border border-dashed border-default"
              icon="i-ph-layout-light"
              title="No primitives enabled"
              description="Enable Agents, Blob, Database, KV, Rate Limit, Sandbox, Workspace, Workflow, Queue, or Schedule in the ViteHub configuration to add a Console page."
            />
          </div>
        </main>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
