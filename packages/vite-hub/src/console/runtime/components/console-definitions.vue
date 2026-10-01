<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleContributedSection, ConsoleDefinitionSummary, ConsoleRecord, ConsoleSectionContent } from "../definitions";
import { requestConsole } from "../client/request";
import { consoleScheduleRunDescription, runConsoleScheduleDefinition } from "../client/schedule-run";
import type { ConsoleScheduleRunView } from "../client/schedule-run";
import { parseConsoleSectionContent } from "../definitions";
import { rememberConsoleSection } from "../sections";
import ConsoleBrand from "./console-brand.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleSearch from "./console-search.vue";
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
const scheduleRuns = ref<Record<string, ConsoleScheduleRunView>>({});
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
const canRunSelected = computed(() =>
  Boolean(props.scheduleRunBase && selectedDefinition.value?.runnable),
);
const selectedRun = computed(() =>
  selectedName.value ? scheduleRuns.value[selectedName.value] : undefined,
);
const selectedRecord = computed(() => records.value.find((row) => row.id === selectedName.value));
const selectedEntry = computed(() => entries.value.find((entry) => entry.id === selectedName.value));

function errorMessage(value: unknown): string | undefined {
  return value instanceof Error
    ? value.message
    : value
      ? "The Console could not load these definitions."
      : undefined;
}

async function runSelectedSchedule(): Promise<void> {
  const name = selectedName.value;
  if (!name || !props.scheduleRunBase || !canRunSelected.value || runningSchedule.value) return;
  runningSchedule.value = name;
  try {
    const run = await runConsoleScheduleDefinition(props.scheduleRunBase, name);
    scheduleRuns.value = { ...scheduleRuns.value, [name]: run };
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
  scheduleRuns.value = {};
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
  <ConsoleFrame>
    <UDashboardSidebar
      id="console-navigation"
      v-model:open="sidebarOpen"
      :default-size="16"
      :collapsed-size="4"
      :min-size="13"
      :max-size="26"
      :menu="{
        title: itemsTitle,
        description: sectionDetails.description,
      }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'h-11 shrink-0 border-t border-default px-2 py-1.5' }"
      resizable
    >
      <template #header="{ collapsed }">
        <ConsoleBrand :collapsed="collapsed" :sections-base="sectionsBase" />
      </template>

      <template #default="{ collapsed }">
        <div class="flex shrink-0 items-center gap-1 px-[0.875rem] pb-2 pt-1">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="vitehub-console__search min-w-0 flex-1 rounded-md border border-default bg-transparent px-2 ring-0 hover:bg-elevated/60"
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
              v-for="entry in entries"
              :key="entry.id"
              :text="entry.id"
              :content="{ side: 'right' }"
            >
              <UButton
                :icon="sectionDetails.icon"
                color="neutral"
                :variant="selectedName === entry.id ? 'soft' : 'ghost'"
                block
                :aria-label="entry.id"
                @click="selectDefinition(entry.id)"
              />
            </UTooltip>
          </div>
        </div>
        <div v-else-if="loading && !entries.length" class="grid gap-2 px-3">
          <USkeleton v-for="index in 6" :key="index" class="h-11 rounded-md" />
        </div>
        <nav
          v-else-if="entries.length"
          class="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          :aria-label="itemsTitle"
        >
          <UButton
            v-for="entry in entries"
            :key="entry.id"
            block
            class="justify-start py-2"
            color="neutral"
            :variant="selectedName === entry.id ? 'soft' : 'ghost'"
            @click="selectDefinition(entry.id)"
          >
            <span class="grid min-w-0 gap-0.5 text-start">
              <span class="truncate font-mono text-xs">{{ entry.id }}</span>
              <span class="truncate text-[11px] text-muted">{{ entry.detail }}</span>
            </span>
          </UButton>
        </nav>
        <UEmpty
          v-else-if="!loading && !error && !collapsed"
          class="min-h-0 flex-1 px-4"
          :icon="sectionDetails.icon"
          :title="`No ${itemsTitle}`"
          :description="catalogView ? `Add a discovered ${sectionDetails.label.slice(0, -1)} Definition to this project.` : 'The owner package returned no records.'"
        />
      </template>

      <template #footer="{ collapsed }">
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
          :toggle="{ 'aria-label': `Open ${itemsTitle}` }"
          :ui="{ root: 'border-b border-default' }"
        >
          <template #title>
            <span class="min-w-0">
              <p class="truncate font-mono text-xs font-medium text-highlighted">
                {{ selectedEntry?.id || sectionDetails.label }}
              </p>
              <p v-if="selectedEntry?.detail" class="mt-0.5 truncate text-[11px] text-muted">
                {{ selectedEntry.detail }}
              </p>
            </span>
          </template>
          <template #right>
            <UButton
              v-if="canRunSelected"
              color="neutral"
              icon="i-ph-play-light"
              label="Run now"
              size="xs"
              variant="outline"
              :disabled="Boolean(runningSchedule)"
              :loading="runningSchedule === selectedName"
              @click="runSelectedSchedule"
            />
            <UBadge color="neutral" label="Read-only" size="sm" variant="soft" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <UEmpty
          v-if="!selectedEntry && !loading"
          class="min-h-0 flex-1"
          icon="i-ph-mouse-left-click-light"
          :title="catalogView ? 'Select a definition' : 'Select a record'"
          :description="catalogView ? 'Choose a discovered definition from the sidebar to inspect its metadata.' : 'Choose a record from the sidebar to inspect its fields.'"
        />
        <div
          v-else-if="loading && !selectedEntry"
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
              v-if="selectedRun"
              :color="selectedRun.status === 'succeeded' ? 'success' : selectedRun.status === 'failed' || selectedRun.status === 'unavailable' ? 'error' : 'neutral'"
              :icon="selectedRun.status === 'succeeded' ? 'i-ph-check-circle-light' : 'i-ph-warning-circle-light'"
              :title="selectedRun.status === 'unavailable' ? 'Could not run this Schedule' : `Run ${selectedRun.status}`"
              :description="consoleScheduleRunDescription(selectedRun)"
              variant="subtle"
            />
            <UAlert
              v-else
              color="neutral"
              icon="i-ph-info-light"
              title="Definition metadata only"
              :description="sectionDetails.view.notice"
              variant="subtle"
            />
          </div>
        </main>
        <main v-else-if="selectedRecord" class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div class="mx-auto grid w-full max-w-5xl gap-4">
            <section class="overflow-x-auto rounded-lg border border-default bg-default">
              <table class="w-full text-left text-xs">
                <thead class="border-b border-default">
                  <tr>
                    <th
                      v-for="column in recordColumns"
                      :key="column.key"
                      class="h-10 px-3 text-[10px] font-semibold uppercase tracking-[.1em] text-muted"
                      scope="col"
                    >
                      {{ column.label }}
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-default">
                  <tr
                    v-for="row in records"
                    :key="row.id"
                    class="cursor-pointer hover:bg-elevated/60"
                    :class="{ 'bg-elevated': row.id === selectedName }"
                    :aria-selected="row.id === selectedName"
                    @click="selectDefinition(row.id)"
                  >
                    <td v-for="column in recordColumns" :key="column.key" class="break-words px-3 py-2 font-mono text-highlighted">
                      {{ row.cells[column.key] || "" }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
            <section class="overflow-hidden rounded-lg border border-default bg-default">
              <div class="flex h-10 items-center border-b border-default px-3">
                <h2 class="truncate font-mono text-xs font-medium text-highlighted">{{ selectedRecord.id }}</h2>
              </div>
              <dl class="divide-y divide-default">
                <div
                  v-for="field in selectedRecord.fields"
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
              title="Read-only records"
              :description="sectionDetails.view.notice"
              variant="subtle"
            />
          </div>
        </main>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
