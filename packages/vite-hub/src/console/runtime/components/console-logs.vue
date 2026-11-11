<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as v from "valibot";
import { useVirtualList } from "@vueuse/core";
import { logPageSchema, logSourceInfoSchema } from "../../../logs/source";
import type { LogEntry, LogSourceInfo } from "../../../logs/source";
import { requestConsole } from "../client/request";
import { queryChoice, querySelection, queryText, useConsoleQuery } from "../client/route-query";
import { consoleClockTime, exactTimestamps } from "../client/format";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleSetupHint from "./console-setup-hint.vue";
import ConsoleState from "./console-state.vue";
import ConsolePropertyList from "./console-property-list.vue";
import ConsoleSection from "./console-section.vue";

const props = defineProps<{ logsBase: string; sectionsBase: string }>();
// The rail's Search button and Cmd+K open the search of the page. Its API routes sit next to the sections route.
const apiBase = props.sectionsBase.replace(/\/sections$/, "");
const levelValues = ["all", "debug", "info", "warn", "error"] as const;
// The view, search, level, and open event live in the URL, so a reload or a shared link opens the same view.
const { entry: selectedId, level, q: text, view: mode } = useConsoleQuery({
  entry: querySelection(),
  level: queryChoice(levelValues, "all"),
  q: queryText(),
  view: queryChoice(["explorer", "stream"], "explorer", { history: "push" }),
});
const selectedProperties = computed(() => (selected.value ? [
  { label: "Time", mono: true, value: selected.value.timestamp },
  { label: "Service", value: selected.value.service },
  { label: "Event ID", mono: true, value: selected.value.id },
] : []));
function clearFilters(): void {
  text.value = "";
  level.value = "all";
}
// The row shows the day without the year; the title of the time shows the exact timestamp.
const logDateFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" });
function logDate(timestamp: string) {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? logDateFormat.format(time) : "";
}
const entries = ref<LogEntry[]>([]);
const {
  list: visibleEntries,
  containerProps,
  wrapperProps,
  scrollTo,
} = useVirtualList(entries, { itemHeight: 32, overscan: 8 });
const source = ref<LogSourceInfo>();
// Without an open event in the URL, or when the open event left the list, the newest event shows.
const selected = computed(() => entries.value.find((entry) => entry.id === selectedId.value) ?? entries.value[0]);
const cursor = ref<string>();
// The first load starts on mount, so the page opens in its loading state instead of the empty state.
const loading = ref(true);
const error = ref<unknown>();
const following = ref(false);
const dropped = ref(0);
let request: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const responseSchema = v.union([
  v.object({ source: v.null() }),
  v.object({ source: logSourceInfoSchema, page: logPageSchema }),
]);
const retention = computed(() =>
  source.value?.retention.kind === "memory"
    ? `Temporary · this process · ${source.value.retention.maxEntries} events maximum`
    : source.value?.retention.description,
);
const levels = [
  { label: "All levels", value: "all" },
  { label: "Debug", value: "debug" },
  { label: "Info", value: "info" },
  { label: "Warn", value: "warn" },
  { label: "Error", value: "error" },
];
/** The color of a level in the event list and in the event details. */
const modeItems = [
  { label: "Explorer", value: "explorer" },
  { label: "Stream", value: "stream" },
];
function levelClass(value: string): string {
  return value === "error" ? "text-error" : value === "warn" ? "text-warning" : "text-muted";
}
const diagnostic = computed(() => {
  const data = selected.value?.data;
  if (!data) return undefined;
  const nested = v.safeParse(v.record(v.string(), v.unknown()), data.error ?? data.diagnostic);
  return nested.success ? nested.output : data;
});
const docs = computed(() => {
  const parsed = v.safeParse(v.string(), diagnostic.value?.docs);
  if (!parsed.success) return undefined;
  try {
    const url = new URL(parsed.output);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
});
function exactTitle(value: string): string | undefined {
  const exact = exactTimestamps(value);
  return exact && `${exact.local}\n${exact.utc}`;
}
function field(value: unknown): string {
  return typeof value === "string" ? value : "";
}
async function load(older = false) {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = undefined;
  const params = new URLSearchParams({ limit: "200" });
  if (text.value.trim()) params.set("text", text.value.trim());
  if (level.value !== "all") params.set("level", level.value);
  if (older && cursor.value) params.set("cursor", cursor.value);
  try {
    const result = v.parse(
      responseSchema,
      await requestConsole(props.logsBase, {
        signal: controller.signal,
        query: Object.fromEntries(params),
      }),
    );
    if (controller.signal.aborted || disposed) return;
    source.value = result.source ?? undefined;
    if (!("page" in result)) {
      entries.value = [];
      return;
    }
    const page = result.page;
    entries.value = older
      ? [
          ...new Map(
            [...entries.value, ...page.entries].map((entry) => [entry.id, entry]),
          ).values(),
        ].slice(0, 1000)
      : page.entries;
    cursor.value = entries.value.length < 1000 ? page.cursor : undefined;
    if (!older) scrollTo(0);
    dropped.value = page.dropped ?? 0;
  } catch (cause) {
    if (!controller.signal.aborted && !disposed)
      error.value = cause;
  } finally {
    if (request === controller) loading.value = false;
  }
}
function schedule() {
  clearTimeout(timer);
  if (following.value && !disposed)
    timer = setTimeout(async () => {
      await load();
      schedule();
    }, 2000);
}
watch(following, schedule);
watch([text, level], () => {
  clearTimeout(debounce);
  request?.abort();
  debounce = setTimeout(() => load(), 250);
});
onMounted(() => load());
onBeforeUnmount(() => {
  disposed = true;
  request?.abort();
  clearTimeout(timer);
  clearTimeout(debounce);
});
</script>

<template>
    <ConsoleSearch :agents-base="`${apiBase}/agents`" :definitions-base="`${apiBase}/definitions`" :kv-base="`${apiBase}/kv`" :search-base="`${apiBase}/search`" :sections-base="sectionsBase" />
    <UDashboardPanel id="logs">
      <ConsolePageHeader title="Logs" :description="source?.label" :toggle="false">
        <template #right>
          <UTooltip text="Refresh logs">
            <UButton
              variant="ghost"
              icon="i-lucide-refresh-cw"
              aria-label="Refresh logs"
              :loading="loading"
              @click="load()"
            />
          </UTooltip>
          <!-- The label names the next action, so the button is not a pressed toggle. -->
          <UButton
            variant="ghost"
            :icon="following ? 'i-lucide-pause' : 'i-lucide-play'"
            @click="following = !following"
            >{{ following ? "Pause" : "Follow" }}</UButton
          >
        </template>
      </ConsolePageHeader>
      <ConsolePageToolbar>
        <template #tabs>
          <UTabs v-model="mode" :items="modeItems" :content="false" aria-label="Log view" />
        </template>
        <UInput
          v-model="text"
          icon="i-lucide-search"
          class="min-w-24 flex-1 max-w-80"
          placeholder="Search structured events…"
          aria-label="Search logs"
          :disabled="!!source && !source.filters.includes('text')"
        />
        <USelect
          v-model="level"
          :items="levels"
          aria-label="Log level"
          :disabled="!!source && !source.filters.includes('level')"
          class="w-32"
        />
      </ConsolePageToolbar>
      <!-- A failed refresh keeps the loaded events on screen; a failed first load replaces them. -->
      <div v-if="error && entries.length" class="shrink-0 px-4 pt-3">
        <ConsoleState compact :error="error" title="Could not refresh logs" :retry="() => load()" />
      </div>
      <ConsoleState v-if="error && !entries.length" :error="error" title="Could not load logs" :retry="() => load()" />
      <ConsoleState v-else-if="!source && !loading" section="logs" icon="i-vitehub-logs" title="Connect a log source">
        <p class="max-w-sm text-xs leading-5 text-pretty text-muted">
          <ConsoleSetupHint :hint="{ message: 'Set `observability: { logs: true }` to capture events in development, or set `observability.logs.source` to a server module that reads your log backend.' }" />
        </p>
      </ConsoleState>
      <div v-else class="logs-workspace min-h-0 flex-1">
        <section aria-label="Log events" class="flex min-h-0 min-w-0 flex-col">
          <div
            class="sticky top-0 z-10 flex justify-between bg-default px-4 py-2 text-xs text-muted"
          >
            <span class="tabular-nums">{{ entries.length === 1 ? "1 event" : `${entries.length} events` }}{{ following ? " · polling every 2s" : "" }}</span
            ><span>Newest first</span>
          </div>
          <p v-if="loading && !entries.length" role="status" class="p-6 text-sm text-muted">
            Loading events…
          </p>
          <UEmpty
            v-else-if="!entries.length"
            role="status"
            variant="naked"
            size="sm"
            icon="i-lucide-search"
            :title="text || level !== 'all' ? 'No events match these filters' : 'No events yet'"
            :description="text || level !== 'all' ? 'Change the search or the level.' : 'Events show here when the application logs them.'"
            :actions="text || level !== 'all' ? [{ label: 'Clear filters', variant: 'ghost', onClick: clearFilters }] : undefined"
          />
          <div v-bind="containerProps" class="min-h-0 flex-1 overflow-auto">
            <!-- The inset keeps the hover fill off the edges; data-focus-inset keeps the focus ring inside the scroller. -->
            <div v-bind="wrapperProps" class="px-1">
              <button
                v-for="{ data: entry } in visibleEntries"
                :key="entry.id"
                class="log-row w-full rounded-md text-left hover:bg-elevated"
                :class="[{ 'bg-elevated': selected?.id === entry.id }, mode]"
                data-focus-inset
                :aria-pressed="selected?.id === entry.id"
                @click="selectedId = entry.id"
              >
                <time
                  class="whitespace-nowrap font-mono text-xs text-muted tabular-nums"
                  :datetime="entry.timestamp"
                  :title="exactTitle(entry.timestamp)"
                  ><span class="text-dimmed">{{ logDate(entry.timestamp) }}</span> {{ consoleClockTime(entry.timestamp) }}</time
                >
                <span class="font-mono text-xs uppercase" :class="levelClass(entry.level)">{{
                  entry.level
                }}</span>
                <span v-if="mode === 'explorer'" class="truncate text-xs text-muted">{{
                  entry.service
                }}</span>
                <span class="truncate text-[13px]">{{ entry.message }}</span>
              </button>
            </div>
          </div>
          <div v-if="cursor && !following" class="p-3">
            <UButton variant="ghost" :loading="loading" @click="load(true)"
              >Load older events</UButton
            >
          </div>
        </section>
        <aside
          aria-label="Event details"
          class="min-h-0 min-w-0 overflow-auto border-l border-default p-5"
        >
          <ConsoleSection v-if="selected" title="Event details" class="gap-5">
            <template #actions>
              <span class="font-mono text-xs uppercase" :class="levelClass(selected.level)">{{ selected.level }}</span>
            </template>
            <p class="break-words text-sm font-medium text-highlighted">{{ selected.message }}</p>
            <!-- The exact timestamp, not a relative time: a log is read next to other logs. -->
            <ConsolePropertyList :items="selectedProperties">
              <template #value="{ item }">{{ item.value }}</template>
            </ConsolePropertyList>
            <div
              v-if="
                diagnostic &&
                (diagnostic.code || diagnostic.name || diagnostic.why || diagnostic.fix)
              "
              class="space-y-3 text-sm"
            >
              <p v-if="diagnostic.code || diagnostic.name" class="font-mono text-xs text-error">
                {{ field(diagnostic.code ?? diagnostic.name) }}
              </p>
              <p v-if="diagnostic.why">{{ field(diagnostic.why) }}</p>
              <p v-if="diagnostic.fix">
                <span class="text-muted">Fix </span>{{ field(diagnostic.fix) }}
              </p>
              <a
                v-if="docs"
                :href="docs"
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary underline"
                >Documentation</a
              >
            </div>
            <ConsoleSection :level="3" title="Structured data">
              <pre class="whitespace-pre-wrap break-all font-mono text-xs leading-6">{{
                JSON.stringify(selected.data, null, 2)
              }}</pre>
            </ConsoleSection>
          </ConsoleSection>
          <UEmpty v-else variant="naked" size="sm" icon="i-lucide-mouse-pointer-click" title="No event selected" description="Select an event to inspect its data." />
        </aside>
      </div>
      <footer
        v-if="source"
        class="flex flex-wrap justify-between gap-2 border-t border-default px-4 py-2 text-xs text-muted"
      >
        <span>{{ retention }}</span
        ><span v-if="dropped">{{ dropped }} dropped or evicted</span><span>Read-only</span>
      </footer>
    </UDashboardPanel>
</template>

<style scoped>
.logs-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 38%);
}
.log-row {
  display: grid;
  gap: 12px;
  align-items: center;
  /* 32px rows, as in the other Console lists. The virtual list uses the same item height. */
  height: 2rem;
  padding: 0 16px;
}
.log-row.explorer {
  grid-template-columns: 140px 40px 90px minmax(0, 1fr);
}
.log-row.stream {
  grid-template-columns: 140px 40px minmax(0, 1fr);
}
@media (max-width: 900px) {
  .log-row.explorer {
    grid-template-columns: 140px 40px minmax(0, 1fr);
  }
  .log-row.explorer > :nth-child(3) {
    display: none;
  }
}
@media (max-width: 640px) {
  .logs-workspace {
    grid-template-columns: minmax(0, 1fr);
    overflow: auto;
  }
  .logs-workspace > section {
    min-height: 240px;
    max-height: 40vh;
  }
  .logs-workspace > aside {
    border-left: 0;
    border-top: 1px solid var(--ui-border);
    min-height: 280px;
  }
}
</style>
