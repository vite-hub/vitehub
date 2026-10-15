<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleContributedSection, ConsoleDefinitionSummary, ConsoleRecord, ConsoleSectionContent } from "../definitions";
import { requestConsole } from "../client/request";
import { consoleScheduleRunDescription, runConsoleScheduleDefinition } from "../client/schedule-run";
import type { ConsoleScheduleRunView } from "../client/schedule-run";
import { parseConsoleSectionContent } from "../definitions";
import { rememberConsoleSection } from "../sections";
import { consoleStatusValue } from "../client/format";
import ConsoleFrame from "./console-frame.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePropertyList from "./console-property-list.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleSetupHint from "./console-setup-hint.vue";
import ConsoleStatus from "./console-status.vue";
import ConsoleValue from "./console-value.vue";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  /** Descriptor of the contributed section. The owner package defines it. */
  details: ConsoleContributedSection;
  kvBase: string;
  scheduleRunBase?: string;
  searchBase: string;
  sectionsBase: string;
}>();

interface ConsoleSectionEntry {
  detail: string;
  id: string;
}

const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const content = ref<ConsoleSectionContent>();
const selectedName = ref<string>();
const loading = ref(true);
const error = ref<unknown>();
const scheduleRuns = ref(new Map<string, ConsoleScheduleRunView>());
const runningSchedule = ref<string>();
let request: AbortController | undefined;

const section = computed(() => props.details.id);
const sectionDetails = computed(() => props.details);
const catalogView = computed(() => props.details.view.kind === "definition-catalog");
const recordColumns = computed(() => props.details.view.kind === "record-table" ? props.details.view.columns : []);
const selectionQuery = computed(() => catalogView.value ? "definition" : "record");
const itemsTitle = computed(() => catalogView.value ? `${sectionDetails.value.label} Definitions` : sectionDetails.value.label);
const definitions = computed<readonly ConsoleDefinitionSummary[]>(() =>
  content.value?.kind === "definition-catalog" ? content.value.definitions : [],
);
const records = computed<readonly ConsoleRecord[]>(() =>
  content.value?.kind === "record-table" ? content.value.records : [],
);
const entries = computed<ConsoleSectionEntry[]>(() =>
  catalogView.value
    ? definitions.value.map((definition) => ({ detail: sourceLabel(definition.source), id: definition.name }))
    : records.value.map((row) => ({ detail: recordSummary(row), id: row.id })),
);
const selectedDefinition = computed(() =>
  definitions.value.find((definition) => definition.name === selectedName.value),
);
const selectedRecord = computed(() => records.value.find((row) => row.id === selectedName.value));
const canRunSelected = computed(() =>
  Boolean(props.scheduleRunBase && (selectedDefinition.value?.runnable || selectedRecord.value?.runnable)),
);
const selectedRun = computed(() =>
  selectedName.value ? scheduleRuns.value.get(selectedName.value) : undefined,
);
const selectedEntry = computed(() => entries.value.find((entry) => entry.id === selectedName.value));

/** The fields of the selected Definition, with its name, source, and file first. */
const definitionFields = computed(() => {
  const definition = selectedDefinition.value;
  if (!definition) return [];
  return [
    { label: "Name", mono: true, value: definition.name },
    { label: "Source", value: sourceLabel(definition.source) },
    { label: "File", mono: true, value: definition.file },
    ...definition.fields.map(field => ({ label: field.label, value: field.value })),
  ];
});

/** A manual run result as a status: `Run succeeded` with a green dot, or why it did not run. */
function runStatus(run: ConsoleScheduleRunView): { label: string, pending?: boolean, tone: "error" | "neutral" | "success" | "warning" } {
  const status = consoleStatusValue(run.status);
  return {
    label: run.status === "unavailable" ? "Could not run this Schedule" : `Run ${run.status}`,
    tone: status?.tone ?? "neutral",
    ...(status?.pending ? { pending: true } : {}),
  };
}

function errorMessage(value: unknown): string | undefined {
  return value instanceof Error
    ? value.message
    : value
      ? "The Console could not load these definitions."
      : undefined;
}

async function runSelectedSchedule(): Promise<void> {
  const name = selectedRecord.value?.cells.schedule || selectedName.value;
  if (!name || !props.scheduleRunBase || !canRunSelected.value || runningSchedule.value) return;
  const selection = selectedName.value;
  if (!selection) return;
  runningSchedule.value = selection;
  try {
    const run = await runConsoleScheduleDefinition(props.scheduleRunBase, name);
    scheduleRuns.value.set(selection, run);
  } finally {
    runningSchedule.value = undefined;
  }
}

function sourceLabel(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() || ""}${part.slice(1)}`)
    .join(" ");
}

function recordSummary(row: ConsoleRecord): string {
  const column = recordColumns.value[0];
  return column ? row.cells[column.key] || "" : "";
}

function queryValue(): string | undefined {
  const value = route.query[selectionQuery.value];
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router query values require string narrowing before selection.
  return typeof value === "string" ? value : undefined;
}

async function loadDefinitions(): Promise<void> {
  request?.abort();
  const previousSelection = selectedName.value;
  content.value = undefined;
  selectedName.value = undefined;
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  const current = section.value;
  const kind = props.details.view.kind;
  try {
    const installed = parseConsoleSectionContent(
      await requestConsole(props.definitionsBase, {
        query: { section: current },
        signal: controller.signal,
      }),
      current,
    );
    if (!installed || installed.kind !== kind) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0098({ message: "The Console returned an invalid definition catalog." });
    }
    if (request !== controller) return;
    content.value = installed;
    selectedName.value = entries.value.some((entry) => entry.id === previousSelection)
      ? previousSelection
      : entries.value[0]?.id;
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
  if (route.query[selectionQuery.value] !== name) {
    void router.replace({ query: { ...route.query, [selectionQuery.value]: name } });
  }
}

onMounted(() => {
  rememberConsoleSection(section.value);
  selectedName.value = queryValue() ?? selectedName.value;
  void loadDefinitions();
});

watch(section, (current) => {
  rememberConsoleSection(current);
  scheduleRuns.value.clear();
  content.value = undefined;
  error.value = undefined;
  selectedName.value = queryValue();
  void loadDefinitions();
});

watch(
  () => route.query[selectionQuery.value],
  (name) => {
    if (name === undefined) {
      selectedName.value = entries.value[0]?.id;
    } else if (
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router query values require string narrowing before selection.
      typeof name === "string" &&
      entries.value.some((entry) => entry.id === name)
    ) {
      selectDefinition(name);
    }
  },
);
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <ConsoleFrame :active="section" :sections-base="sectionsBase">
    <UDashboardSidebar
      id="console-navigation"
      class="vitehub-console__nav"
      v-model:open="sidebarOpen"
      :default-size="16"
      :collapsed-size="4"
      :min-size="13"
      :max-size="26"
      :menu="{
        title: itemsTitle,
        description: sectionDetails.description,
      }"
      :ui="{ body: 'gap-0 overflow-hidden p-0' }"
      resizable
    >
      <template #header="{ collapsed }">
        <div v-if="!collapsed" class="vitehub-console__panel-title">
          <span class="min-w-0 flex-1 truncate">{{ sectionDetails.label }}</span>
          <UTooltip text="Refresh">
            <UButton aria-label="Refresh definitions" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :loading="loading" @click="loadDefinitions" />
          </UTooltip>
        </div>
        <UTooltip v-else text="Refresh" :content="{ side: 'right' }">
          <UButton class="mx-auto" aria-label="Refresh definitions" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :loading="loading" @click="loadDefinitions" />
        </UTooltip>
      </template>

      <template #default="{ collapsed }">
        <nav class="vitehub-console__section-nav" :class="{ 'is-collapsed': collapsed }" :aria-label="itemsTitle">
          <div v-if="!collapsed && errorMessage(error)" class="px-1 pb-2">
            <UAlert
              color="error"
              variant="subtle"
              icon="i-lucide-cloud-off"
              title="Couldn't load definitions"
              :description="errorMessage(error)"
              :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: loadDefinitions }]"
            />
          </div>
          <template v-else-if="loading && !entries.length">
            <USkeleton v-for="index in 4" :key="index" class="my-0.5 h-11 rounded-md" />
          </template>
          <template v-else-if="entries.length">
            <UTooltip v-for="entry in entries" :key="entry.id" :text="entry.id" :content="{ side: 'right' }" :disabled="!collapsed">
              <button
                type="button"
                class="vitehub-console__section-link text-start"
                :class="{ 'is-detailed': !collapsed && entry.detail }"
                :aria-current="selectedName === entry.id ? 'true' : undefined"
                :aria-label="collapsed ? entry.id : undefined"
                @click="selectDefinition(entry.id)"
              >
                <UIcon v-if="collapsed" :name="sectionDetails.icon" class="vitehub-console__section-icon" aria-hidden="true" />
                <span v-else class="grid min-w-0 gap-0.5">
                  <span class="truncate font-mono text-xs">{{ entry.id }}</span>
                  <span v-if="entry.detail" class="truncate text-xs font-normal text-dimmed">{{ entry.detail }}</span>
                </span>
              </button>
            </UTooltip>
          </template>
          <p v-else-if="!collapsed && !loading && !error" class="px-2 py-1.5 text-xs leading-relaxed text-muted">
            {{ catalogView ? `No ${sectionDetails.label} Definitions in this project yet.` : "The owner package returned no records." }}
          </p>
        </nav>
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
      <ConsolePageHeader :title="selectedEntry?.id || sectionDetails.label">
        <template #right>
          <span class="hidden text-xs text-dimmed sm:inline">Read-only</span>
          <UButton
            v-if="canRunSelected"
            icon="i-lucide-play"
            label="Run now"
            size="sm"
            variant="outline"
            :disabled="Boolean(runningSchedule)"
            :loading="runningSchedule === selectedName"
            @click="runSelectedSchedule"
          />
        </template>
      </ConsolePageHeader>

      <div class="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        <div v-if="loading && !selectedEntry" class="mx-auto grid w-full max-w-4xl gap-3 p-4 sm:p-6" aria-busy="true">
          <USkeleton class="h-4 w-40" />
          <USkeleton v-for="index in 5" :key="index" class="h-9 w-full" />
        </div>
        <UEmpty
          v-else-if="!selectedEntry"
          variant="naked"
          class="py-16"
          :icon="sectionDetails.icon"
          :title="catalogView ? 'No definition selected' : 'No record selected'"
          :description="entries.length ? `Choose one from the sidebar to see its ${catalogView ? 'metadata' : 'fields'}.` : 'Nothing to show yet.'"
        />
        <main v-else-if="selectedDefinition" class="mx-auto grid w-full max-w-4xl gap-6 p-4 sm:p-6">
          <div v-if="selectedRun" class="grid gap-1" role="status">
            <ConsoleStatus :label="runStatus(selectedRun).label" :tone="runStatus(selectedRun).tone" :pending="runStatus(selectedRun).pending" />
            <p v-if="consoleScheduleRunDescription(selectedRun)" class="ps-3.5 text-xs text-muted tabular-nums">{{ consoleScheduleRunDescription(selectedRun) }}</p>
          </div>
          <ConsolePropertyList title="Definition" :items="definitionFields" />
          <p class="flex gap-2 text-xs leading-relaxed text-muted">
            <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <ConsoleSetupHint :hint="{ message: sectionDetails.view.notice }" />
          </p>
        </main>
        <main v-else-if="selectedRecord" class="mx-auto grid w-full max-w-6xl gap-6 p-4 sm:p-6">
          <div v-if="selectedRun" class="grid gap-1" role="status">
            <ConsoleStatus :label="runStatus(selectedRun).label" :tone="runStatus(selectedRun).tone" :pending="runStatus(selectedRun).pending" />
            <p v-if="consoleScheduleRunDescription(selectedRun)" class="ps-3.5 text-xs text-muted tabular-nums">{{ consoleScheduleRunDescription(selectedRun) }}</p>
          </div>
          <section class="overflow-x-auto" :aria-label="sectionDetails.label">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-default">
                  <th v-for="column in recordColumns" :key="column.key" class="h-8 whitespace-nowrap px-2 text-xs font-medium text-dimmed" scope="col">
                    {{ column.label }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in records"
                  :key="row.id"
                  class="h-10 cursor-pointer border-b border-default hover:bg-elevated"
                  :class="{ 'bg-accented hover:bg-accented': row.id === selectedName }"
                  :aria-selected="row.id === selectedName"
                  @click="selectDefinition(row.id)"
                >
                  <td v-for="column in recordColumns" :key="column.key" class="px-2 py-1.5 align-middle text-highlighted">
                    <ConsoleValue :value="row.cells[column.key] || ''" />
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
          <ConsolePropertyList title="Fields" :items="selectedRecord.fields" />
          <p class="flex gap-2 text-xs leading-relaxed text-muted">
            <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <ConsoleSetupHint :hint="{ message: sectionDetails.view.notice }" />
          </p>
        </main>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
