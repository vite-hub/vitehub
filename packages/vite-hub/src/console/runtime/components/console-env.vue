<script setup lang="ts">
import { Status } from "@vite-hub/ui";
import type { ServerEnvDescriptionEntry } from "@vite-hub/env";
import * as v from "valibot";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";

import { consoleEnvName, groupConsoleEnv } from "../client/env-groups";
import { indexEnvStatuses } from "../client/env-status";
import { requestConsole } from "../client/request";
import { querySelection, queryText, useConsoleQuery } from "../client/route-query";
import { rememberConsoleSection } from "../sections";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleEnvDetails from "./console-env-details.vue";
import ConsoleState from "./console-state.vue";

const descriptionSchema = v.object({
  entries: v.array(
    v.object({
      path: v.optional(v.string()),
      source: v.picklist(["env", "literal", "provider"]),
      provider: v.optional(v.string()),
      secret: v.boolean(),
      required: v.boolean(),
      hasDefault: v.boolean(),
      type: v.optional(v.string()),
    }),
  ),
  status: v.optional(
    v.array(
      v.object({
        blocking: v.boolean(),
        path: v.optional(v.string()),
        status: v.picklist(["available", "defaulted", "error", "invalid", "missing"]),
      }),
    ),
  ),
});
type EnvStatus = NonNullable<v.InferOutput<typeof descriptionSchema>["status"]>[number];
const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  envBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const entries = ref<readonly ServerEnvDescriptionEntry[]>([]);
// The search, source, and open variable live in the URL, so a reload or a shared link opens the same view.
const { q: search, source, variable } = useConsoleQuery({
  q: queryText(),
  source: queryText({ fallback: "all" }),
  variable: querySelection(),
});
/** After a status check, shows only the values that block the application. */
const attentionOnly = ref(false);
// A variable without a disclosed path has no name for the URL. It stays open until another selection.
const undisclosed = shallowRef<ServerEnvDescriptionEntry>();
const selected = computed({
  get: () => undisclosed.value ?? (variable.value ? entries.value.find((entry) => entry.path === variable.value) : undefined),
  set: (entry: ServerEnvDescriptionEntry | undefined) => {
    undisclosed.value = entry && !entry.path ? entry : undefined;
    if (variable.value === entry?.path) return;
    variable.value = entry?.path;
  },
});
const loading = ref(true);
const failed = ref<unknown>();
// Status is loaded on request because inspection can call providers.
const statuses = ref<ReadonlyMap<ServerEnvDescriptionEntry, EnvStatus>>();
const statusFailed = ref(false);
// A status check can call providers, so the button shows progress and the toolbar shows when it finished.
const checking = ref(false);
const checkedAt = ref<Date>();
const statusUnavailable = ref(false);
let request: AbortController | undefined;
const detailOpen = computed({
  get: () => Boolean(selected.value),
  set: (open: boolean) => {
    if (!open) selected.value = undefined;
  },
});
const sourceLabel = (entry: ServerEnvDescriptionEntry) =>
  entry.source === "env"
    ? "Host environment"
    : entry.source === "literal"
      ? "Application config"
      : entry.provider || "External provider";
const sourceItems = computed(() => [
  { label: "All sources", value: "all" },
  ...Array.from(new Set(entries.value.map(sourceLabel)))
    .sort()
    .map((label) => ({ label, value: label })),
]);
const rows = computed(() => {
  const query = search.value.trim().toLowerCase();
  return entries.value.filter(
    (entry) =>
      (source.value === "all" || sourceLabel(entry) === source.value) &&
      (!attentionOnly.value || Boolean(statuses.value?.get(entry)?.blocking)) &&
      `${consoleEnvName(entry) ?? ""} ${sourceLabel(entry)} ${entry.type ?? ""}`.toLowerCase().includes(query),
  );
});
const groups = computed(() => groupConsoleEnv(rows.value));
const secretCount = computed(() => entries.value.filter((entry) => entry.secret).length);
const summary = computed(() => {
  const total = plural(entries.value.length, "variable");
  if (rows.value.length !== entries.value.length) return `${rows.value.length} of ${total}`;
  return secretCount.value ? `${total} · ${plural(secretCount.value, "secret")}` : total;
});
const blockingCount = computed(() => entries.value.filter((entry) => statuses.value?.get(entry)?.blocking).length);
const statusLabels: Record<EnvStatus["status"], string> = {
  available: "Available",
  defaulted: "Default",
  error: "Provider error",
  invalid: "Invalid",
  missing: "Missing",
};
function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}
function status(entry: ServerEnvDescriptionEntry) {
  const value = statuses.value?.get(entry);
  if (!value) return undefined;
  return {
    label: statusLabels[value.status],
    tone: value.blocking ? "error" : value.status === "available" ? "success" : "neutral",
  } as const;
}
async function refresh(includeStatus = false) {
  request?.abort();
  const current = new AbortController();
  request = current;
  loading.value = true;
  checking.value = includeStatus;
  failed.value = undefined;
  statusFailed.value = false;
  statusUnavailable.value = false;
  try {
    const result = v.parse(
      descriptionSchema,
      await requestConsole(props.envBase, {
        query: includeStatus ? { status: 1 } : undefined,
        signal: current.signal,
      }),
    );
    if (current.signal.aborted) return;
    entries.value = result.entries;
    statuses.value = result.status
      ? indexEnvStatuses(result.entries, result.status)
      : undefined;
    if (includeStatus) {
      checkedAt.value = new Date();
      statusUnavailable.value = !result.status;
    }
    if (!blockingCount.value) attentionOnly.value = false;
    if (!sourceItems.value.some((item) => item.value === source.value)) source.value = "all";
    if (undisclosed.value && !entries.value.includes(undisclosed.value)) undisclosed.value = undefined;
  } catch (cause) {
    if (current.signal.aborted) return;
    if (includeStatus && entries.value.length) {
      statuses.value = undefined;
      attentionOnly.value = false;
      statusFailed.value = true;
    }
    else failed.value = cause;
  } finally {
    if (!current.signal.aborted) {
      loading.value = false;
      checking.value = false;
    }
  }
}
const checkedTime = computed(() => checkedAt.value?.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }));
onMounted(() => {
  rememberConsoleSection("env");
  void refresh(false);
});
onBeforeUnmount(() => request?.abort());
</script>

<template>
    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />
    <UDashboardPanel id="env">
      <ConsolePageHeader title="Env" :toggle="false">
        <template #right>
          <UButton
            icon="i-lucide-heart-pulse"
            label="Check status"
            variant="ghost"
            :loading="checking"
            :disabled="loading"
            @click="refresh(true)"
          />
          <UTooltip text="Refresh declarations">
            <UButton
              aria-label="Refresh declarations"
              icon="i-lucide-refresh-cw"
              variant="ghost"
              :disabled="loading"
              @click="refresh()"
            />
          </UTooltip>
        </template>
      </ConsolePageHeader>
      <ConsolePageToolbar v-if="entries.length" width="4xl">
        <UInput
          v-model="search"
          class="w-full sm:w-64"
          icon="i-lucide-search"
          placeholder="Filter variables…"
          aria-label="Filter variables"
        />
        <USelect
          v-if="sourceItems.length > 2"
          v-model="source"
          :items="sourceItems"
          class="w-44"
          aria-label="Filter by source"
        />
        <div class="ms-auto flex items-center gap-3 text-xs text-muted tabular-nums" aria-live="polite">
          <span v-if="statusFailed" role="alert" class="text-error">Could not check status. Try again.</span>
          <span v-else-if="statusUnavailable">This host cannot check status.</span>
          <!-- An on and off filter, not a view switch, so it stays a pressed button. -->
          <UButton
            v-else-if="statuses && blockingCount"
            variant="ghost"
            size="xs"
            :class="attentionOnly ? 'bg-elevated' : undefined"
            :aria-pressed="attentionOnly"
            @click="attentionOnly = !attentionOnly"
          >
            <Status :label="`${plural(blockingCount, 'value')} ${blockingCount === 1 ? 'needs' : 'need'} attention`" tone="error" />
          </UButton>
          <Status v-else-if="statuses" label="All values resolve" tone="success" />
          <span v-if="checkedTime && !checking && !statusFailed" class="text-dimmed">Checked at {{ checkedTime }}</span>
          <span>{{ summary }}</span>
        </div>
      </ConsolePageToolbar>

      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ConsoleState v-if="failed" :error="failed" title="Could not load Env declarations" :retry="() => refresh()" />
        <div v-else-if="loading && !entries.length" class="mx-auto grid w-full max-w-4xl gap-2 p-4 sm:p-6" aria-busy="true">
          <USkeleton class="mb-1 h-4 w-32" />
          <USkeleton v-for="index in 8" :key="index" class="h-10 w-full" />
        </div>
        <ConsoleState
          v-else-if="!entries.length"
          section="env"
          icon="i-vitehub-env"
          title="No Server Env declared"
          description="Declare a value under env.server in the Vite config to inspect it here."
        />
        <UEmpty
          v-else-if="!rows.length"
          variant="naked"
          class="my-auto"
          icon="i-lucide-search"
          title="No matching variables"
          :description="attentionOnly && !search.trim() ? 'No values match the filters.' : `No variables match “${search.trim() || source}”.`"
        />
        <main v-else class="mx-auto grid w-full max-w-4xl gap-6 p-4 sm:p-6">
          <section
            v-for="group in groups"
            :key="group.name ?? '(undisclosed)'"
            class="grid gap-2"
            :aria-label="group.name || (group.name === '' ? 'Other variables' : 'Undisclosed variables')"
          >
            <h2 v-if="groups.length > 1" class="flex items-baseline gap-2 px-1 text-xs">
              <span v-if="group.name" class="font-mono font-medium text-highlighted">{{ group.name }}</span>
              <span v-else class="font-medium text-highlighted">{{ group.name === "" ? "Other" : "Undisclosed" }}</span>
              <span class="text-dimmed tabular-nums">{{ group.rows.length }}</span>
              <span v-if="group.name === undefined" class="text-dimmed">Their declarations do not disclose a name.</span>
            </h2>
            <!-- The list does not clip, so the focus ring of a row stays visible. The end rows round their own corners. -->
            <ul role="list" class="divide-y divide-default rounded-lg border border-default">
              <li v-for="(row, index) in group.rows" :key="row.entry.path ?? `undisclosed-${index}`" class="first:*:rounded-t-md last:*:rounded-b-md">
                <button
                  type="button"
                  class="group grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-3 py-2 text-start hover:bg-elevated"
                  data-focus-inset
                  :aria-current="selected === row.entry ? 'true' : undefined"
                  @click="selected = row.entry"
                >
                  <span class="flex min-w-0 items-center gap-2">
                    <span v-if="row.name" class="truncate font-mono text-[13px]" :title="consoleEnvName(row.entry)"
                      ><span class="text-dimmed">{{ row.parent }}</span><span class="text-highlighted">{{ row.name }}</span></span
                    >
                    <span v-else class="truncate text-[13px] text-muted">Undisclosed name</span>
                    <span v-if="row.entry.secret" class="inline-flex shrink-0 items-center gap-1 text-xs text-muted">
                      <UIcon name="i-lucide-lock" class="size-3" aria-hidden="true" />Secret
                    </span>
                  </span>
                  <span class="flex items-center gap-4 text-xs">
                    <Status v-if="status(row.entry)" class="w-28" v-bind="status(row.entry)" />
                    <span
                      class="hidden w-24 truncate text-end font-mono text-dimmed md:block"
                      :title="row.entry.type"
                      >{{ row.entry.type }}</span
                    >
                    <span class="hidden w-36 truncate text-muted sm:block">{{ sourceLabel(row.entry) }}</span>
                    <UIcon name="i-lucide-chevron-right" class="size-3.5 text-dimmed group-hover:text-muted" aria-hidden="true" />
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </main>
      </div>
    </UDashboardPanel>
    <USlideover
      v-model:open="detailOpen"
      :title="(selected && consoleEnvName(selected)) || 'Undisclosed name'"
      description="Declaration details"
      :ui="{ title: 'font-mono text-sm', description: 'sr-only' }"
    >
      <template #body
        ><ConsoleEnvDetails v-if="selected" :entry="selected" :status="selected && status(selected)"
      /></template>
    </USlideover>
</template>
