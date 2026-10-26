<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleContributedSection, ConsoleDefinitionSummary, ConsoleRecord, ConsoleSectionContent } from "../definitions";
import { requestConsole } from "../client/request";
import { consoleScheduleRunDescription, runConsoleScheduleDefinition } from "../client/schedule-run";
import type { ConsoleScheduleRunView } from "../client/schedule-run";
import { parseConsoleSectionContent } from "../definitions";
import { isConsoleSectionReadOnly } from "../client/read-only";
import { rememberConsoleSection } from "../sections";
import { consoleStatusValue } from "../client/format";
import ConsoleFrame from "./console-frame.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePropertyList from "./console-property-list.vue";
import ConsoleRateLimit from "./console-rate-limit.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleSetupHint from "./console-setup-hint.vue";
import ConsoleState from "./console-state.vue";
import ConsoleStatus from "./console-status.vue";
import ConsoleValue from "./console-value.vue";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  /** Descriptor of the contributed section. The owner package defines it. */
  details: ConsoleContributedSection;
  kvBase: string;
  /** Route of the Rate Limits operations. Only the Rate Limits section reads and resets counters. */
  rateLimitBase?: string;
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
const sectionReadOnly = ref(false);
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
// A detail line that every entry shares, such as "Queue" under each Queue, tells nothing, so the sidebar hides it.
const showEntryDetail = computed(() => new Set(entries.value.map((entry) => entry.detail)).size > 1);
/** Records open in a slideover over the full table. Closing it clears the selection. */
const recordOpen = computed({
  get: () => Boolean(selectedRecord.value),
  set: (open: boolean) => {
    if (!open) selectRecord(undefined);
  },
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

/** The first column names a record, such as an Email subject. The id is the fallback. */
function recordTitle(row: ConsoleRecord): string {
  return recordSummary(row) || row.id;
}

function recordSummary(row: ConsoleRecord): string {
  const column = recordColumns.value[0];
  return column ? row.cells[column.key] || "" : "";
}

function queryValue(): string | undefined {
  const value = route.query[selectionQuery.value];
  return typeof value === "string" ? value : undefined;
}

async function loadDefinitions(): Promise<void> {
  request?.abort();
  const previousSelection = selectedName.value ?? (catalogView.value ? undefined : queryValue());
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
      : catalogView.value ? entries.value[0]?.id : undefined;
    if (!catalogView.value && selectedName.value === undefined) selectRecord(undefined);
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

function selectRecord(name: string | undefined): void {
  if (name) return selectDefinition(name);
  selectedName.value = undefined;
  const { [selectionQuery.value]: _selection, ...query } = route.query;
  void router.replace({ query });
}

function selectDefinition(name: string): void {
  selectedName.value = name;
  sidebarOpen.value = false;
  if (route.query[selectionQuery.value] !== name) {
    void router.replace({ query: { ...route.query, [selectionQuery.value]: name } });
  }
}

onMounted(() => {
  void isConsoleSectionReadOnly(props.sectionsBase, section.value).then((value) => { sectionReadOnly.value = value; });
  rememberConsoleSection(section.value);
  selectedName.value = queryValue() ?? selectedName.value;
  void loadDefinitions();
});

watch(section, (current) => {
  void isConsoleSectionReadOnly(props.sectionsBase, current).then((value) => { sectionReadOnly.value = value; });
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
      selectedName.value = catalogView.value ? entries.value[0]?.id : undefined;
    } else if (
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
    <!-- Records list in the page table, so only Definition catalogs need a sidebar. -->
    <UDashboardSidebar
      v-if="catalogView"
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
          <div v-if="!collapsed && error" class="px-1 pb-2">
            <ConsoleState compact :error="error" title="Couldn't load definitions" :retry="loadDefinitions" />
          </div>
          <template v-else-if="loading && !entries.length">
            <USkeleton v-for="index in 4" :key="index" class="my-0.5 h-11 rounded-md" />
          </template>
          <template v-else-if="entries.length">
            <UTooltip v-for="entry in entries" :key="entry.id" :text="entry.id" :content="{ side: 'right' }" :disabled="!collapsed">
              <button
                type="button"
                class="vitehub-console__section-link text-start"
                :class="{ 'is-detailed': !collapsed && entry.detail && showEntryDetail }"
                :aria-current="selectedName === entry.id ? 'true' : undefined"
                :aria-label="collapsed ? entry.id : undefined"
                @click="selectDefinition(entry.id)"
              >
                <UIcon v-if="collapsed" :name="sectionDetails.icon" class="vitehub-console__section-icon" aria-hidden="true" />
                <span v-else class="grid min-w-0 gap-0.5">
                  <span class="truncate font-mono text-xs">{{ entry.id }}</span>
                  <span v-if="entry.detail && showEntryDetail" class="truncate text-xs font-normal text-dimmed">{{ entry.detail }}</span>
                </span>
              </button>
            </UTooltip>
          </template>
          <p v-else-if="!collapsed && !loading && !error" class="px-2 py-1.5 text-xs leading-relaxed text-muted">
            No {{ sectionDetails.label }} Definitions in this project yet.
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
      <ConsolePageHeader :title="(catalogView && selectedEntry?.id) || sectionDetails.label" :toggle="catalogView">
        <template #right>
          <span v-if="!rateLimitBase" class="hidden text-xs text-dimmed sm:inline">Read-only</span>
          <UButton
            v-if="canRunSelected && catalogView"
            icon="i-lucide-play"
            label="Run now"
            size="sm"
            variant="outline"
            :disabled="Boolean(runningSchedule)"
            :loading="runningSchedule === selectedName"
            @click="runSelectedSchedule"
          />
          <UTooltip v-if="!catalogView" text="Refresh">
            <UButton aria-label="Refresh records" icon="i-lucide-refresh-cw" size="sm" variant="ghost" :loading="loading" @click="loadDefinitions" />
          </UTooltip>
        </template>
      </ConsolePageHeader>

      <div class="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        <div v-if="loading && !content" class="mx-auto grid w-full max-w-3xl gap-3 p-4 sm:p-6" aria-busy="true">
          <USkeleton class="h-4 w-40" />
          <USkeleton v-for="index in 5" :key="index" class="h-9 w-full" />
        </div>
        <template v-else-if="!catalogView">
          <ConsoleState v-if="error" :error="error" :title="`Couldn't load ${sectionDetails.label}`" :retry="loadDefinitions" />
          <main v-else class="mx-auto grid w-full max-w-5xl content-start gap-4 p-4 sm:p-6">
            <UEmpty
              v-if="!records.length"
              variant="naked"
              class="py-16"
              :icon="sectionDetails.icon"
              :title="`No ${sectionDetails.label} yet`"
              description="Records show here when the application creates them."
            />
            <section v-else class="overflow-x-auto rounded-md border border-default" :aria-label="sectionDetails.label">
              <table class="w-full text-left text-[13px]">
                <thead>
                  <tr class="border-b border-default bg-elevated/30">
                    <th v-for="column in recordColumns" :key="column.key" class="h-9 whitespace-nowrap px-3 text-xs font-medium text-muted" scope="col">
                      {{ column.label }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in records"
                    :key="row.id"
                    class="relative h-11 border-b border-default last:border-b-0 hover:bg-elevated/50"
                    :class="{ 'bg-elevated': row.id === selectedName }"
                    :aria-selected="row.id === selectedName"
                  >
                    <td v-for="(column, index) in recordColumns" :key="column.key" class="max-w-80 truncate px-3 py-2 align-middle" :class="index ? 'text-muted' : 'text-highlighted'">
                      <!-- The first cell holds the row's button, and its overlay makes the whole row clickable. -->
                      <button
                        v-if="!index"
                        type="button"
                        class="text-start font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-1 focus-visible:after:ring-inset focus-visible:after:ring-primary"
                        @click="selectRecord(row.id)"
                      >
                        {{ row.cells[column.key] || row.id }}
                      </button>
                      <ConsoleValue v-else :value="row.cells[column.key] || ''" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
            <p class="flex gap-2 text-xs leading-relaxed text-pretty text-muted">
              <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <ConsoleSetupHint :hint="{ message: sectionDetails.view.notice }" />
            </p>
          </main>
        </template>
        <UEmpty
          v-else-if="!selectedDefinition"
          variant="naked"
          class="py-16"
          :icon="sectionDetails.icon"
          title="No definition selected"
          :description="entries.length ? 'Choose one from the sidebar to see its metadata.' : 'Nothing to show yet.'"
        />
        <main v-else class="mx-auto grid w-full max-w-3xl gap-8 p-4 sm:p-6">
          <header class="grid gap-3">
            <dl class="flex flex-wrap gap-x-10 gap-y-3">
              <div class="grid min-w-0 gap-1">
                <dt class="text-xs text-dimmed">Source</dt>
                <dd class="text-[13px] text-highlighted">{{ sourceLabel(selectedDefinition.source) }}</dd>
              </div>
              <div class="grid min-w-0 gap-1">
                <dt class="text-xs text-dimmed">File</dt>
                <dd class="break-all font-mono text-xs leading-5 text-highlighted">{{ selectedDefinition.file }}</dd>
              </div>
            </dl>
            <div v-if="selectedRun" class="grid gap-1" role="status">
              <ConsoleStatus :label="runStatus(selectedRun).label" :tone="runStatus(selectedRun).tone" :pending="runStatus(selectedRun).pending" />
              <p v-if="consoleScheduleRunDescription(selectedRun)" class="ps-3.5 text-xs text-muted tabular-nums">{{ consoleScheduleRunDescription(selectedRun) }}</p>
            </div>
          </header>
          <ConsolePropertyList v-if="selectedDefinition.fields.length" title="Configuration" :items="selectedDefinition.fields" />
          <ConsoleRateLimit v-if="rateLimitBase" :base="rateLimitBase" :name="selectedDefinition.name" :read-only="sectionReadOnly" />
          <p class="flex gap-2 rounded-md bg-elevated/50 px-3 py-2.5 text-xs leading-relaxed text-pretty text-muted">
            <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <ConsoleSetupHint :hint="{ message: sectionDetails.view.notice }" />
          </p>
        </main>
      </div>
    </UDashboardPanel>
    <USlideover
      v-if="!catalogView"
      v-model:open="recordOpen"
      :title="selectedRecord ? recordTitle(selectedRecord) : sectionDetails.label"
      :description="selectedRecord?.id"
      :ui="{ content: 'sm:max-w-xl', description: 'font-mono text-xs' }"
    >
      <template #body>
        <article v-if="selectedRecord" class="grid gap-6">
          <div v-if="canRunSelected || selectedRun" class="flex flex-wrap items-start justify-between gap-3">
            <div v-if="selectedRun" class="grid gap-1" role="status">
              <ConsoleStatus :label="runStatus(selectedRun).label" :tone="runStatus(selectedRun).tone" :pending="runStatus(selectedRun).pending" />
              <p v-if="consoleScheduleRunDescription(selectedRun)" class="ps-3.5 text-xs text-muted tabular-nums">{{ consoleScheduleRunDescription(selectedRun) }}</p>
            </div>
            <UButton
              v-if="canRunSelected"
              class="ms-auto"
              icon="i-lucide-play"
              label="Run now"
              size="sm"
              variant="outline"
              :disabled="Boolean(runningSchedule)"
              :loading="runningSchedule === selectedName"
              @click="runSelectedSchedule"
            />
          </div>
          <ConsolePropertyList title="Fields" :items="selectedRecord.fields" />
        </article>
      </template>
    </USlideover>
  </ConsoleFrame>
</template>
