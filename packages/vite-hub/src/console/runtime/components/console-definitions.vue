<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { ConsoleDefinitionSectionId, ConsoleDefinitionSummary } from "../definitions";
import { requestConsole } from "../client/request";
import { consoleSectionDetails, rememberConsoleSection } from "../sections";
import ConsoleBackButton from "./console-back-button.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSearch from "./console-search.vue";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  searchBase: string;
  section: ConsoleDefinitionSectionId;
  sectionsBase: string;
}>();

const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
const definitions = ref<ConsoleDefinitionSummary[]>([]);
const filter = ref("");
const selectedName = ref<string>();
const loading = ref(true);
const error = ref<unknown>();
let request: AbortController | undefined;

const sectionDetails = computed(() => consoleSectionDetails[props.section]);
const definitionNotice = computed(() => ({
  databases: "Database rows, SQL execution, migrations, and credentials are not included in this build-time Definition catalog.",
  queues: "Queue backlog, message, and delivery history are not exposed by ViteHub's provider-independent Queue contract yet.",
  "rate-limits": "Live counters and remaining quota are not included because their accuracy, scope, and availability depend on the provider.",
  sandboxes: "Running Sandboxes, files, processes, logs, ports, and lifecycle state are not included in this build-time catalog.",
  schedules: "Runtime-created Schedules and run history are not included in this build-time Definition catalog yet.",
  workspaces: "Workspace files, Sources, collections, sync state, and processes are not opened or initialized by this build-time catalog.",
  workflows: "Workflow run history is not exposed by ViteHub's provider-independent Workflow contract yet.",
})[props.section]);
const filteredDefinitions = computed(() => {
  const query = filter.value.trim().toLocaleLowerCase();
  if (!query) return definitions.value;
  return definitions.value.filter(definition =>
    [definition.name, definition.file, definition.source, ...definition.fields.map(field => field.value)]
      .some(value => value.toLocaleLowerCase().includes(query)),
  );
});
const selectedDefinition = computed(() =>
  definitions.value.find(definition => definition.name === selectedName.value),
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

function parseDefinitions(value: unknown): ConsoleDefinitionSummary[] {
  const source = record(value);
  if (source?.section !== props.section || !Array.isArray(source.definitions)) {
    throw new TypeError("The Console returned an invalid definition catalog.");
  }
  return source.definitions.flatMap((entry) => {
    const definition = record(entry);
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate definition identity and source metadata at this boundary.
    const valid = typeof definition?.name === "string" && typeof definition.file === "string" && typeof definition.source === "string";
    return valid
      ? [{
          fields: parseFields(definition.fields),
          file: definition.file,
          name: definition.name,
          source: definition.source,
        }]
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
    .map(part => `${part[0]?.toLocaleUpperCase() || ""}${part.slice(1)}`)
    .join(" ");
}

async function loadDefinitions(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  try {
    const installed = parseDefinitions(await requestConsole(props.definitionsBase, {
      query: { section: props.section },
      signal: controller.signal,
    }));
    if (request !== controller) return;
    definitions.value = installed;
    selectedName.value = installed.some(definition => definition.name === selectedName.value)
      ? selectedName.value
      : installed[0]?.name;
    error.value = undefined;
  }
  catch (requestError) {
    if (requestError instanceof Object && "name" in requestError && requestError.name === "AbortError") return;
    if (request === controller) error.value = requestError;
  }
  finally {
    if (request === controller) {
      request = undefined;
      loading.value = false;
    }
  }
}

function selectDefinition(name: string): void {
  selectedName.value = name;
  sidebarOpen.value = false;
}

watch(filteredDefinitions, (available) => {
  if (available.some(definition => definition.name === selectedName.value)) return;
  selectedName.value = available[0]?.name;
});

onMounted(() => {
  rememberConsoleSection(props.section);
  void loadDefinitions();
});
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
      :menu="{ title: `${sectionDetails.label} Definitions`, description: sectionDetails.description }"
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
            <strong class="mt-1 truncate text-sm font-semibold text-highlighted">{{ sectionDetails.label }}</strong>
          </span>
        </div>
      </template>

      <template #default="{ collapsed }">
        <div class="px-2 pt-2">
          <ConsoleBackButton :collapsed="collapsed" />
        </div>
        <div v-if="!collapsed" class="flex items-end justify-between px-4 pb-3 pt-5">
          <div>
            <span class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">Discovered</span>
            <h1 class="mt-1 text-lg font-semibold tracking-tight text-highlighted">Definitions</h1>
          </div>
          <span class="text-xs text-muted">{{ filteredDefinitions.length }}</span>
        </div>
        <div class="px-2 pb-3" :class="collapsed ? 'pt-2' : ''">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="w-full bg-transparent ring-default"
            label="Search console"
          />
        </div>
        <div v-if="!collapsed" class="px-3 pb-3">
          <UInput
            v-model="filter"
            aria-label="Filter definitions"
            icon="i-lucide-search"
            placeholder="Filter definitions"
            size="sm"
          />
        </div>
        <div v-if="!collapsed && errorMessage(error)" class="px-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Could not load definitions"
            :description="errorMessage(error)"
            :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: loadDefinitions }]"
          />
        </div>
        <div v-if="collapsed" class="min-h-0 flex-1 overflow-y-auto">
          <div class="grid gap-1 px-2 py-1">
            <UTooltip
              v-for="definition in filteredDefinitions"
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
          v-else-if="filteredDefinitions.length"
          class="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          :aria-label="`${sectionDetails.label} Definitions`"
        >
          <button
            v-for="definition in filteredDefinitions"
            :key="definition.name"
            type="button"
            class="grid min-h-11 w-full gap-0.5 rounded-md px-2 py-2 text-start outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary"
            :class="selectedName === definition.name ? 'bg-elevated text-highlighted' : 'text-toned'"
            @click="selectDefinition(definition.name)"
          >
            <span class="truncate font-mono text-xs">{{ definition.name }}</span>
            <span class="truncate text-[11px] text-muted">{{ sourceLabel(definition.source) }}</span>
          </button>
        </nav>
        <UEmpty
          v-else-if="!loading && !error && !collapsed"
          class="min-h-0 flex-1 px-4"
          :icon="sectionDetails.icon"
          :title="filter ? 'No matching definitions' : `No ${sectionDetails.label} Definitions`"
          :description="filter ? 'Try a shorter filter.' : `Add a discovered ${sectionDetails.label.slice(0, -1)} Definition to this project.`"
        />
      </template>

      <template #footer="{ collapsed, collapse }">
        <span v-if="!collapsed" class="flex items-center gap-1.5 text-xs text-muted">
          <UIcon name="i-lucide-lock-keyhole" class="size-3.5" />Read-only
        </span>
        <UTooltip text="Refresh definitions">
          <UButton
            aria-label="Refresh definitions"
            color="neutral"
            icon="i-lucide-refresh-cw"
            size="xs"
            variant="ghost"
            :loading="loading"
            @click="loadDefinitions"
          />
        </UTooltip>
        <UButton
          class="max-lg:hidden"
          :class="collapsed ? '' : 'ml-1'"
          :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
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
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel :id="`${section}-definition`">
      <div class="flex min-h-0 flex-1 flex-col" aria-live="polite">
        <header class="flex h-14 shrink-0 items-center border-b border-default px-4">
          <UButton
            class="mr-2 lg:hidden"
            :aria-label="`Open ${sectionDetails.label} Definitions`"
            color="neutral"
            icon="i-lucide-panel-left"
            variant="ghost"
            @click="sidebarOpen = true"
          />
          <div class="min-w-0">
            <p class="truncate font-mono text-xs font-medium text-highlighted">
              {{ selectedDefinition?.name || sectionDetails.label }}
            </p>
            <p v-if="selectedDefinition" class="mt-0.5 truncate text-[11px] text-muted">
              {{ sourceLabel(selectedDefinition.source) }}
            </p>
          </div>
          <UBadge class="ml-auto" color="neutral" label="Read-only" size="sm" variant="soft" />
        </header>

        <UEmpty
          v-if="!selectedDefinition && !loading"
          class="min-h-0 flex-1"
          icon="i-lucide-mouse-pointer-click"
          title="Select a definition"
          description="Choose a discovered definition from the sidebar to inspect its metadata."
        />
        <div v-else-if="loading && !selectedDefinition" class="flex min-h-0 flex-1 items-center justify-center">
          <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" />
        </div>
        <main v-else-if="selectedDefinition" class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div class="mx-auto grid w-full max-w-5xl gap-4">
            <section class="overflow-hidden rounded-lg border border-default bg-default">
              <div class="flex h-10 items-center border-b border-default px-3">
                <h2 class="text-xs font-medium text-highlighted">Definition</h2>
              </div>
              <dl class="divide-y divide-default">
                <div class="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">Name</dt>
                  <dd class="break-all font-mono text-xs text-highlighted">{{ selectedDefinition.name }}</dd>
                </div>
                <div class="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">Source</dt>
                  <dd class="text-xs text-highlighted">{{ sourceLabel(selectedDefinition.source) }}</dd>
                </div>
                <div class="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">File</dt>
                  <dd class="break-all font-mono text-xs text-highlighted">{{ selectedDefinition.file }}</dd>
                </div>
                <div
                  v-for="field in selectedDefinition.fields"
                  :key="field.label"
                  class="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4"
                >
                  <dt class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">{{ field.label }}</dt>
                  <dd class="break-words font-mono text-xs text-highlighted">{{ field.value }}</dd>
                </div>
              </dl>
            </section>
            <UAlert
              color="neutral"
              icon="i-lucide-info"
              title="Definition metadata only"
              :description="definitionNotice"
              variant="subtle"
            />
          </div>
        </main>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
