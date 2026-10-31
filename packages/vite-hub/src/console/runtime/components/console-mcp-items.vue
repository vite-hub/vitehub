<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { consoleMcpAccount, consoleMcpInitials, consoleMcpPromptSchema, consoleMcpToolHints, requestConsoleMcp } from "../client/mcp-client";
import ConsoleMcpContent from "./console-mcp-content.vue";
import ConsoleSchemaForm from "./console-schema-form.vue";
import ConsoleState from "./console-state.vue";

import type { ConsoleMcpConnection, ConsoleMcpListKind, ConsoleMcpOutcome } from "../mcp-client";

/**
 * The tools, resources, or prompts of one connection: a filterable list, and the selected item with its arguments and
 * results. "Run as" sends the same request through other connections to the same server, so two accounts can be
 * compared side by side.
 */
const props = defineProps<{
  base: string;
  connection: ConsoleMcpConnection;
  kind: "prompts" | "resources" | "tools";
  /** Connections to the same server, including `connection`. */
  peers: readonly ConsoleMcpConnection[];
}>();

const emit = defineEmits<{
  /** A request returned the latest state of a connection. */
  connection: [connection: ConsoleMcpConnection];
  /** A request failed, so the connection list may be out of date. */
  failed: [];
}>();

const selected = defineModel<string | undefined>("selected");

type Item = Record<string, unknown>;
interface Result { error?: unknown, outcome?: ConsoleMcpOutcome, pending?: boolean }

const items = ref<Item[]>([]);
const templates = ref<Item[]>([]);
const loading = ref(false);
const error = ref<unknown>();
const filter = ref("");
const values = ref<Record<string, unknown>>({});
const templateUri = ref("");
const runAs = ref<string[]>([props.connection.id]);
const results = ref<Record<string, Result>>({});
let request: AbortController | undefined;

const nouns = { prompts: "prompts", resources: "resources", tools: "tools" } as const;
const action = computed(() => ({ prompts: "Get prompt", resources: "Read", tools: "Run" })[props.kind]);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The key of an item: the name of a tool or prompt, the URI of a resource, or the URI template of a template. */
function keyOf(item: Item): string {
  return text(item.uri) || text(item.uriTemplate) || text(item.name);
}

function firstLine(value: unknown): string {
  return text(value).split("\n").find(line => line.trim())?.trim() ?? "";
}

const query = computed(() => filter.value.trim().toLowerCase());
const matches = (item: Item) => !query.value || `${text(item.name)} ${text(item.title)} ${text(item.uri)} ${text(item.uriTemplate)} ${text(item.description)}`.toLowerCase().includes(query.value);
const visibleItems = computed(() => items.value.filter(matches));
const visibleTemplates = computed(() => templates.value.filter(matches));
const current = computed(() => [...items.value, ...templates.value].find(item => keyOf(item) === selected.value));
const isTemplate = computed(() => Boolean(current.value && text(current.value.uriTemplate)));
const schema = computed<Record<string, unknown> | undefined>(() => {
  if (!current.value) return undefined;
  if (props.kind === "prompts") return consoleMcpPromptSchema(current.value);
  return props.kind === "tools" && current.value.inputSchema instanceof Object ? current.value.inputSchema as Record<string, unknown> : undefined;
});
const hasArguments = computed(() => Object.keys((schema.value?.properties as Record<string, unknown> | undefined) ?? {}).length > 0);
const running = computed(() => Object.values(results.value).some(result => result.pending));
const shownResults = computed(() => runAs.value.flatMap(id => {
  const connection = props.peers.find(peer => peer.id === id);
  const result = results.value[id];
  return connection && result ? [{ connection, result }] : [];
}));

async function load(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = undefined;
  try {
    const pages = async (kind: ConsoleMcpListKind) => {
      const all: Item[] = [];
      let cursor: string | undefined;
      // Servers page long lists. Ten pages cover any list a person reads here.
      for (let page = 0; page < 10; page++) {
        const response = await requestConsoleMcp(props.base, "mcp-client.items", { id: props.connection.id, kind, ...(cursor ? { cursor } : {}) }, controller.signal);
        all.push(...response.items);
        emit("connection", response.connection);
        cursor = response.nextCursor;
        if (!cursor) break;
      }
      return all;
    };
    const [list, templateList] = await Promise.all([pages(props.kind), props.kind === "resources" ? pages("resource-templates") : Promise.resolve([])]);
    if (controller.signal.aborted) return;
    items.value = list;
    templates.value = templateList;
    if (selected.value && !current.value) selected.value = undefined;
  }
  catch (cause) {
    if (controller.signal.aborted) return;
    error.value = cause;
    emit("failed");
  }
  finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

function choose(item: Item): void {
  selected.value = keyOf(item);
}

function toggleRunAs(id: string): void {
  if (runAs.value.includes(id)) {
    // At least one connection runs the request.
    if (runAs.value.length > 1) runAs.value = runAs.value.filter(candidate => candidate !== id);
  }
  else runAs.value = props.peers.filter(peer => peer.id === id || runAs.value.includes(peer.id)).map(peer => peer.id);
}

function input(id: string): { input: Record<string, unknown>, operation: "mcp-client.call" | "mcp-client.prompt" | "mcp-client.read" } {
  const item = current.value!;
  if (props.kind === "tools") return { input: { arguments: values.value, id, tool: text(item.name) }, operation: "mcp-client.call" };
  if (props.kind === "prompts") {
    const strings = Object.fromEntries(Object.entries(values.value).flatMap(([name, value]) => value === undefined || value === "" ? [] : [[name, String(value)]]));
    return { input: { arguments: strings, id, name: text(item.name) }, operation: "mcp-client.prompt" };
  }
  return { input: { id, uri: isTemplate.value ? templateUri.value : text(item.uri) }, operation: "mcp-client.read" };
}

async function run(): Promise<void> {
  if (!current.value || running.value) return;
  const ids = [...runAs.value];
  results.value = Object.fromEntries(ids.map(id => [id, { pending: true }]));
  await Promise.all(ids.map(async (id) => {
    const call = input(id);
    try {
      const outcome = await requestConsoleMcp(props.base, call.operation, call.input);
      results.value = { ...results.value, [id]: { outcome } };
      emit("connection", outcome.connection);
    }
    catch (cause) {
      results.value = { ...results.value, [id]: { error: cause } };
      emit("failed");
    }
  }));
}

watch(() => props.kind, () => {
  items.value = [];
  templates.value = [];
  void load();
}, { immediate: true });
watch(() => props.connection.id, (id) => {
  runAs.value = [id];
  void load();
});
watch(selected, () => {
  values.value = {};
  results.value = {};
  templateUri.value = current.value ? text(current.value.uriTemplate) : "";
});
watch(current, (item) => {
  if (item && !templateUri.value) templateUri.value = text(item.uriTemplate);
});
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <div class="grid min-h-0 flex-1 lg:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)]">
    <!-- The list. On a narrow screen it gives way to the selected item. -->
    <section
      class="flex min-h-0 flex-col border-default lg:border-e"
      :class="selected ? 'hidden lg:flex' : 'flex'"
      :aria-label="`${connection.label} ${nouns[kind]}`"
    >
      <div class="flex items-center gap-2 border-b border-default px-3 py-2">
        <UInput
          v-model="filter"
          class="min-w-0 flex-1"
          icon="i-lucide-search"
          size="sm"
          :placeholder="`Filter ${nouns[kind]}…`"
          :aria-label="`Filter ${nouns[kind]}`"
        />
        <UTooltip :text="`Reload ${nouns[kind]}`">
          <UButton :aria-label="`Reload ${nouns[kind]}`" color="neutral" icon="i-lucide-refresh-cw" size="sm" variant="ghost" :loading="loading" @click="load" />
        </UTooltip>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-2" :aria-busy="loading">
        <ConsoleState v-if="error" compact :error="error" :title="`Couldn't load the ${nouns[kind]}`" :retry="load" />
        <template v-else-if="loading && !items.length && !templates.length">
          <USkeleton v-for="index in 6" :key="index" class="mb-1 h-11 w-full rounded-md" />
        </template>
        <p v-else-if="!items.length && !templates.length" class="px-2 py-1.5 text-[13px] text-muted">This server has no {{ nouns[kind] }}.</p>
        <template v-else>
          <p v-if="!visibleItems.length && !visibleTemplates.length" class="px-2 py-1.5 text-[13px] text-muted">No {{ nouns[kind] }} match “{{ filter }}”.</p>
          <ul class="grid gap-px">
            <li v-for="item in visibleItems" :key="keyOf(item)">
              <button
                type="button"
                class="vitehub-mcp-item"
                :aria-current="selected === keyOf(item) ? 'true' : undefined"
                @click="choose(item)"
              >
                <span class="truncate font-mono text-xs font-medium text-highlighted">{{ kind === "resources" ? text(item.title) || text(item.name) : text(item.name) }}</span>
                <span class="truncate text-xs text-dimmed" :class="kind === 'resources' ? 'font-mono' : ''">{{ kind === "resources" ? text(item.uri) : firstLine(item.description) || text(item.title) }}</span>
              </button>
            </li>
          </ul>
          <template v-if="visibleTemplates.length">
            <p class="vitehub-console__section-heading">Templates</p>
            <ul class="grid gap-px">
              <li v-for="item in visibleTemplates" :key="keyOf(item)">
                <button type="button" class="vitehub-mcp-item" :aria-current="selected === keyOf(item) ? 'true' : undefined" @click="choose(item)">
                  <span class="truncate font-mono text-xs font-medium text-highlighted">{{ text(item.title) || text(item.name) }}</span>
                  <span class="truncate font-mono text-xs text-dimmed">{{ text(item.uriTemplate) }}</span>
                </button>
              </li>
            </ul>
          </template>
        </template>
      </div>
    </section>

    <!-- The selected item: what it is, its arguments, and the results. -->
    <section
      v-if="current"
      class="@container min-h-0 overflow-y-auto"
      :aria-label="text(current.name) || text(current.uri)"
      @keydown.meta.enter.prevent="run"
      @keydown.ctrl.enter.prevent="run"
    >
      <div class="mx-auto grid w-full max-w-4xl gap-6 px-4 py-5 sm:px-6">
        <header class="grid gap-2">
          <UButton class="-ms-2 w-fit lg:hidden" color="neutral" icon="i-lucide-arrow-left" size="xs" variant="ghost" :label="`All ${nouns[kind]}`" @click="selected = undefined" />
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="min-w-0 break-all font-mono text-sm font-semibold text-highlighted">{{ text(current.name) || text(current.uriTemplate) }}</h3>
            <UBadge v-for="hint in consoleMcpToolHints(current)" :key="hint.label" :color="hint.tone" variant="outline" size="sm" :label="hint.label" />
            <span v-if="text(current.mimeType)" class="font-mono text-xs text-dimmed">{{ text(current.mimeType) }}</span>
          </div>
          <p v-if="text(current.title) && text(current.title) !== text(current.name)" class="text-[13px] font-medium text-default">{{ text(current.title) }}</p>
          <p v-if="text(current.uri)" class="break-all font-mono text-xs text-muted">{{ text(current.uri) }}</p>
          <p v-if="text(current.description)" class="max-w-[68ch] whitespace-pre-line text-pretty text-[13px] leading-relaxed text-muted">{{ text(current.description) }}</p>
        </header>

        <section v-if="kind !== 'resources'" class="grid gap-2" aria-labelledby="vitehub-mcp-arguments">
          <h4 id="vitehub-mcp-arguments" class="text-xs font-medium text-muted">Arguments</h4>
          <ConsoleSchemaForm v-if="schema && hasArguments" v-model="values" :schema="schema" unfolded @submit="run" />
          <p v-else class="text-[13px] text-dimmed">This {{ kind === "tools" ? "tool" : "prompt" }} takes no arguments.</p>
        </section>
        <UFormField v-else-if="isTemplate" label="URI" description="Fill in the variables of the template." class="grid gap-1">
          <UInput v-model="templateUri" class="w-full font-mono" size="sm" spellcheck="false" autocomplete="off" />
        </UFormField>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <UButton :label="action" icon="i-lucide-play" :loading="running" :disabled="isTemplate && !templateUri.trim()" @click="run" />
          <span class="hidden text-xs text-dimmed sm:inline"><UKbd value="meta" size="sm" /> <UKbd value="enter" size="sm" /></span>
          <div v-if="peers.length > 1" class="flex min-w-0 flex-wrap items-center gap-1.5 sm:ms-auto" role="group" aria-label="Run as">
            <span class="text-xs text-dimmed">Run as</span>
            <UButton
              v-for="peer in peers"
              :key="peer.id"
              size="xs"
              color="neutral"
              :variant="runAs.includes(peer.id) ? 'soft' : 'ghost'"
              :class="runAs.includes(peer.id) ? 'text-highlighted' : 'text-muted'"
              :aria-pressed="runAs.includes(peer.id)"
              @click="toggleRunAs(peer.id)"
            >
              <UAvatar :src="peer.identity?.picture" :alt="consoleMcpAccount(peer).primary" :text="consoleMcpInitials(consoleMcpAccount(peer).primary)" size="3xs" />
              <span class="max-w-32 truncate">{{ consoleMcpAccount(peer).primary }}</span>
            </UButton>
          </div>
        </div>

        <div v-if="shownResults.length" class="grid gap-3" :class="shownResults.length > 1 ? '@3xl:grid-cols-2' : ''" aria-live="polite">
          <article v-for="{ connection: peer, result } in shownResults" :key="peer.id" class="grid min-w-0 content-start gap-3 rounded-lg border border-default p-3">
            <header v-if="shownResults.length > 1" class="flex min-w-0 items-center gap-2">
              <UAvatar :src="peer.identity?.picture" :alt="consoleMcpAccount(peer).primary" :text="consoleMcpInitials(consoleMcpAccount(peer).primary)" size="2xs" />
              <span class="truncate text-[13px] font-medium text-highlighted">{{ consoleMcpAccount(peer).primary }}</span>
              <span v-if="consoleMcpAccount(peer).secondary" class="truncate text-xs text-dimmed">{{ consoleMcpAccount(peer).secondary }}</span>
            </header>
            <div v-if="result.pending" class="grid gap-2" role="status" aria-label="Waiting for the server">
              <USkeleton class="h-5 w-24" />
              <USkeleton class="h-20 w-full" />
            </div>
            <ConsoleState v-else-if="result.error" compact :error="result.error" title="The request failed" />
            <ConsoleMcpContent v-else-if="result.outcome" :outcome="result.outcome" />
          </article>
        </div>
      </div>
    </section>
    <div v-else class="hidden min-h-0 place-items-center p-6 text-center lg:grid">
      <p class="max-w-xs text-pretty text-[13px] text-muted">
        <template v-if="items.length || templates.length">Choose {{ kind === "resources" ? "a resource" : kind === "tools" ? "a tool" : "a prompt" }} to {{ kind === "resources" ? "read it" : kind === "tools" ? "call it" : "fill it in" }}.</template>
      </p>
    </div>
  </div>
</template>

<style>
/* One row of the item list: the name and one quiet line under it, like the detailed rows of the section sidebar. */
.vitehub-mcp-item {
  border-radius: 0.375rem;
  display: grid;
  gap: 0.125rem;
  min-height: 2.75rem;
  padding: 0.375rem 0.5rem;
  text-align: start;
  width: 100%;
}

.vitehub-mcp-item:hover {
  background: var(--ui-bg-elevated);
}

.vitehub-mcp-item[aria-current="true"] {
  background: var(--ui-bg-accented);
}

.vitehub-mcp-item:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}
</style>
