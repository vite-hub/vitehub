<script setup lang="ts">
import type { ServerEnvDescriptionEntry } from "@vite-hub/env";
import * as v from "valibot";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { consoleEnvName, groupConsoleEnv } from "../client/env-groups";
import { indexEnvStatuses } from "../client/env-status";
import { requestConsole } from "../client/request";
import { rememberConsoleSection } from "../sections";
import ConsoleFrame from "./console-frame.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleEnvDetails from "./console-env-details.vue";
import ConsoleState from "./console-state.vue";
import ConsoleStatus from "./console-status.vue";

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
  managementBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const entries = ref<readonly ServerEnvDescriptionEntry[]>([]);
const search = ref("");
const source = ref("all");
/** After a status check, shows only the values that block the application. */
const attentionOnly = ref(false);
const selected = ref<ServerEnvDescriptionEntry>();
const loading = ref(true);
const failed = ref<unknown>();
// Status is loaded on request because inspection can call providers.
const statuses = ref<ReadonlyMap<ServerEnvDescriptionEntry, EnvStatus>>();
const statusFailed = ref(false);
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
  failed.value = undefined;
  statusFailed.value = false;
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
    if (!blockingCount.value) attentionOnly.value = false;
    if (!sourceItems.value.some((item) => item.value === source.value)) source.value = "all";
    selected.value = selected.value
      ? entries.value.find((entry) => entry.path === selected.value?.path)
      : undefined;
  } catch (cause) {
    if (current.signal.aborted) return;
    if (includeStatus && entries.value.length) {
      statuses.value = undefined;
      attentionOnly.value = false;
      statusFailed.value = true;
    }
    else failed.value = cause;
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}
onMounted(() => {
  rememberConsoleSection("env");
  void refresh(false);
});
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <ConsoleFrame active="env" :sections-base="sectionsBase">
    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />
    <UDashboardPanel id="env" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <ConsolePageHeader title="Env" :toggle="false">
        <template #right>
          <UButton
            color="neutral"
            icon="i-lucide-heart-pulse"
            label="Check status"
            size="sm"
            variant="ghost"
            :disabled="loading"
            @click="refresh(true)"
          />
          <UTooltip text="Refresh declarations">
            <UButton
              aria-label="Refresh declarations"
              color="neutral"
              icon="i-lucide-refresh-cw"
              size="sm"
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
          size="sm"
          placeholder="Filter variables…"
          aria-label="Filter variables"
        />
        <USelect
          v-if="sourceItems.length > 2"
          v-model="source"
          :items="sourceItems"
          class="w-44"
          size="sm"
          aria-label="Filter by source"
        />
        <div class="ms-auto flex items-center gap-3 text-xs text-muted tabular-nums" aria-live="polite">
          <span v-if="statusFailed" role="alert" class="text-error">Could not check status.</span>
          <button
            v-else-if="statuses && blockingCount"
            type="button"
            class="rounded-sm px-1 outline-none hover:bg-elevated focus-visible:ring-1 focus-visible:ring-primary"
            :class="attentionOnly ? 'bg-elevated' : ''"
            :aria-pressed="attentionOnly"
            @click="attentionOnly = !attentionOnly"
          >
            <ConsoleStatus :label="`${plural(blockingCount, 'value')} need attention`" tone="error" />
          </button>
          <ConsoleStatus v-else-if="statuses" label="All values resolve" tone="success" />
          <span>{{ summary }}</span>
        </div>
      </ConsolePageToolbar>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <ConsoleState v-if="failed" :error="failed" title="Could not load Env declarations" :retry="() => refresh()" />
        <div v-else-if="loading && !entries.length" class="mx-auto grid w-full max-w-4xl gap-2 p-4 sm:p-6" aria-busy="true">
          <USkeleton class="mb-1 h-4 w-32" />
          <USkeleton v-for="index in 8" :key="index" class="h-10 w-full" />
        </div>
        <ConsoleState
          v-else-if="!entries.length"
          section="env"
          icon="i-ph-key-light"
          title="No Server Env declared"
          description="Declare a value under env.server in the Vite config to inspect it here."
        />
        <p v-else-if="!rows.length" class="py-16 text-center text-[13px] text-muted">
          {{ attentionOnly && !search.trim() ? "No values match the filters." : `No variables match “${search.trim() || source}”.` }}
        </p>
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
            <ul role="list" class="divide-y divide-default overflow-hidden rounded-md border border-default">
              <li v-for="(row, index) in group.rows" :key="row.entry.path ?? `undisclosed-${index}`">
                <button
                  type="button"
                  class="group grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-3 py-2 text-start outline-none hover:bg-elevated/50 focus-visible:bg-elevated/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
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
                    <ConsoleStatus v-if="status(row.entry)" class="w-28" v-bind="status(row.entry)" />
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
        ><ConsoleEnvDetails v-if="selected" :entry="selected" :endpoint="managementBase" :status="selected && status(selected)"
      /></template>
    </USlideover>
  </ConsoleFrame>
</template>
