<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleDefinitionSectionId, ConsoleDefinitionSummary } from "../definitions";
import { requestConsole } from "../client/request";
import { consoleSectionDetails, rememberConsoleSection } from "../sections";
import ConsoleBrand from "./console-brand.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleSearch from "./console-search.vue";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  section: ConsoleDefinitionSectionId;
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
const definitions = ref<ConsoleDefinitionSummary[]>([]);
const selectedName = ref<string>();
const loading = ref(true);
const error = ref<unknown>();
let request: AbortController | undefined;

const sectionDetails = computed(() => consoleSectionDetails[props.section]);
const definitionNotice = computed(
  () =>
    ({
      queues:
        "Queue backlog, message, and delivery history are not exposed by ViteHub's provider-independent Queue contract yet.",
      workflows:
        "Workflow run history is not exposed by ViteHub's provider-independent Workflow contract yet.",
    })[props.section],
);
const selectedDefinition = computed(() =>
  definitions.value.find((definition) => definition.name === selectedName.value),
);

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function parseFields(value: unknown): ConsoleDefinitionSummary["fields"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const field = record(entry);
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate definition field labels and values at this boundary.
    return typeof field?.label === "string" && typeof field.value === "string"
      ? [{ label: field.label, value: field.value }]
      : [];
  });
}

function parseDefinitions(
  value: unknown,
  section: ConsoleDefinitionSectionId,
): ConsoleDefinitionSummary[] {
  const source = record(value);
  if (source?.section !== section || !Array.isArray(source.definitions)) {
    throw new TypeError("The Console returned an invalid definition catalog.");
  }
  return source.definitions.flatMap((entry) => {
    const definition = record(entry);
    const valid =
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate each definition field at this boundary.
      typeof definition?.name === "string" &&
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate each definition field at this boundary.
      typeof definition.file === "string" &&
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate each definition field at this boundary.
      typeof definition.source === "string";
    return valid
      ? [
          {
            fields: parseFields(definition.fields),
            file: definition.file,
            name: definition.name,
            source: definition.source,
          },
        ]
      : [];
  });
}

function errorMessage(value: unknown): string | undefined {
  return value instanceof Error
    ? value.message
    : value
      ? "The Console could not load these definitions."
      : undefined;
}

function sourceLabel(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() || ""}${part.slice(1)}`)
    .join(" ");
}

async function loadDefinitions(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  const section = props.section;
  try {
    const installed = parseDefinitions(
      await requestConsole(props.definitionsBase, {
        query: { section },
        signal: controller.signal,
      }),
      section,
    );
    if (request !== controller) return;
    definitions.value = installed;
    selectedName.value = installed.some((definition) => definition.name === selectedName.value)
      ? selectedName.value
      : installed[0]?.name;
    error.value = undefined;
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

function selectDefinition(name: string): void {
  selectedName.value = name;
  sidebarOpen.value = false;
  if (route.query.definition !== name) {
    void router.replace({ query: { ...route.query, definition: name } });
  }
}

onMounted(() => {
  rememberConsoleSection(props.section);
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router query values require string narrowing before selection.
  if (typeof route.query.definition === "string") selectedName.value = route.query.definition;
  void loadDefinitions();
});

watch(
  () => props.section,
  (section) => {
    rememberConsoleSection(section);
    definitions.value = [];
    error.value = undefined;
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router query values require string narrowing before selection.
    selectedName.value = typeof route.query.definition === "string" ? route.query.definition : undefined;
    void loadDefinitions();
  },
);

watch(
  () => route.query.definition,
  (name) => {
    if (
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router query values require string narrowing before selection.
      typeof name === "string" &&
      definitions.value.some((definition) => definition.name === name)
    ) {
      selectDefinition(name);
    }
  },
);
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      :id="`${section}-definitions`"
      v-model:open="sidebarOpen"
      v-model:collapsed="sidebarCollapsed"
      :default-size="21"
      :collapsed-size="4"
      :min-size="17"
      :max-size="28"
      :menu="{
        title: `${sectionDetails.label} Definitions`,
        description: sectionDetails.description,
      }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'border-t border-default px-3 py-2' }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <ConsoleBrand :collapsed="collapsed" :sections-base="sectionsBase" />
      </template>

      <template #default="{ collapsed }">
        <div v-if="!collapsed" class="flex items-end justify-between px-4 pb-3 pt-5">
          <div>
            <span class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted"
              >Discovered</span
            >
            <h1 class="mt-1 text-lg font-semibold tracking-tight text-highlighted">Definitions</h1>
          </div>
          <span class="text-xs text-muted">{{ definitions.length }}</span>
        </div>
        <div class="px-2 pb-3" :class="collapsed ? 'pt-2' : ''">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="w-full bg-transparent ring-default"
            label="Search console"
          />
        </div>
        <div v-if="!collapsed && errorMessage(error)" class="px-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-ph-cloud-slash-light"
            title="Could not load definitions"
            :description="errorMessage(error)"
            :actions="[
              { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: loadDefinitions },
            ]"
          />
        </div>
        <div v-if="collapsed" class="min-h-0 flex-1 overflow-y-auto">
          <div class="grid gap-1 px-2 py-1">
            <UTooltip
              v-for="definition in definitions"
              :key="definition.name"
              :text="definition.name"
              :content="{ side: 'right' }"
            >
              <UButton
                :icon="sectionDetails.icon"
                color="neutral"
                :variant="selectedName === definition.name ? 'soft' : 'ghost'"
                block
                :aria-label="definition.name"
                @click="selectDefinition(definition.name)"
              />
            </UTooltip>
          </div>
        </div>
        <div v-else-if="loading && !definitions.length" class="grid gap-2 px-3">
          <USkeleton v-for="index in 6" :key="index" class="h-11 rounded-md" />
        </div>
        <nav
          v-else-if="definitions.length"
          class="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          :aria-label="`${sectionDetails.label} Definitions`"
        >
          <UButton
            v-for="definition in definitions"
            :key="definition.name"
            block
            class="justify-start py-2"
            color="neutral"
            :variant="selectedName === definition.name ? 'soft' : 'ghost'"
            @click="selectDefinition(definition.name)"
          >
            <span class="grid min-w-0 gap-0.5 text-start">
              <span class="truncate font-mono text-xs">{{ definition.name }}</span>
              <span class="truncate text-[11px] text-muted">{{
                sourceLabel(definition.source)
              }}</span>
            </span>
          </UButton>
        </nav>
        <UEmpty
          v-else-if="!loading && !error && !collapsed"
          class="min-h-0 flex-1 px-4"
          :icon="sectionDetails.icon"
          :title="`No ${sectionDetails.label} Definitions`"
          :description="`Add a discovered ${sectionDetails.label.slice(0, -1)} Definition to this project.`"
        />
      </template>

      <template #footer="{ collapsed, collapse }">
        <ConsolePrimitiveSwitcher
          :active="section"
          :collapsed="collapsed"
          :sections-base="sectionsBase"
        />
        <UTooltip text="Refresh definitions">
          <UButton
            aria-label="Refresh definitions"
            color="neutral"
            icon="i-ph-arrows-clockwise-light"
            class="ml-auto"
            size="xs"
            variant="ghost"
            :loading="loading"
            @click="loadDefinitions"
          />
        </UTooltip>
        <UButton
          class="max-lg:hidden"
          :class="collapsed ? '' : 'ml-1'"
          icon="i-ph-sidebar-simple-light"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="collapsed ? 'Show definitions' : 'Hide definitions'"
          @click="collapse(!collapsed)"
        />
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel
      :id="`${section}-definition`"
      :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }"
    >
      <template #header>
        <UDashboardNavbar
          :toggle="{ 'aria-label': `Open ${sectionDetails.label} Definitions` }"
          :ui="{ root: 'border-b border-default' }"
        >
          <template #title>
            <span class="min-w-0">
              <p class="truncate font-mono text-xs font-medium text-highlighted">
                {{ selectedDefinition?.name || sectionDetails.label }}
              </p>
              <p v-if="selectedDefinition" class="mt-0.5 truncate text-[11px] text-muted">
                {{ sourceLabel(selectedDefinition.source) }}
              </p>
            </span>
          </template>
          <template #right>
            <UBadge color="neutral" label="Read-only" size="sm" variant="soft" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <UEmpty
          v-if="!selectedDefinition && !loading"
          class="min-h-0 flex-1"
          icon="i-ph-mouse-left-click-light"
          title="Select a definition"
          description="Choose a discovered definition from the sidebar to inspect its metadata."
        />
        <div
          v-else-if="loading && !selectedDefinition"
          class="flex min-h-0 flex-1 items-center justify-center"
        >
          <UIcon name="i-ph-circle-notch-light" class="size-4 animate-spin text-muted opacity-70" />
        </div>
        <main v-else-if="selectedDefinition" class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div class="mx-auto grid w-full max-w-5xl gap-4">
            <section class="overflow-hidden rounded-lg border border-default bg-default">
              <div class="flex h-10 items-center border-b border-default px-3">
                <h2 class="text-xs font-medium text-highlighted">Definition</h2>
              </div>
              <dl class="divide-y divide-default">
                <div class="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                    Name
                  </dt>
                  <dd class="break-all font-mono text-xs text-highlighted">
                    {{ selectedDefinition.name }}
                  </dd>
                </div>
                <div class="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                    Source
                  </dt>
                  <dd class="text-xs text-highlighted">
                    {{ sourceLabel(selectedDefinition.source) }}
                  </dd>
                </div>
                <div class="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                    File
                  </dt>
                  <dd class="break-all font-mono text-xs text-highlighted">
                    {{ selectedDefinition.file }}
                  </dd>
                </div>
                <div
                  v-for="field in selectedDefinition.fields"
                  :key="field.label"
                  class="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4"
                >
                  <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                    {{ field.label }}
                  </dt>
                  <dd class="break-words font-mono text-xs text-highlighted">{{ field.value }}</dd>
                </div>
              </dl>
            </section>
            <UAlert
              color="neutral"
              icon="i-ph-info-light"
              title="Definition metadata only"
              :description="definitionNotice"
              variant="subtle"
            />
          </div>
        </main>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
