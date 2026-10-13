<script setup lang="ts">
import { defineShortcuts } from "@nuxt/ui/composables";
import { useCollection } from "vite-hub/source/client";
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { CommandPaletteGroup, CommandPaletteItem } from "@nuxt/ui"
import type { Collection } from "@vite-hub/source"
import type { AgentInvocationListItem } from "@vite-hub/ui"
import type { ConsoleSectionDetails, ConsoleSectionId } from "../sections"
import { consoleAppearanceKey, consoleAppearanceOptions, consoleAppearances } from "../client/appearance"
import { loadConsoleKVPages, requestConsole } from "../client/request"
import { loadConsoleNavigation, resolveConsoleSectionDetails } from "../client/sections"
import type { ConsoleNavigation } from "../client/sections"
import { relativeDuration } from "../client/time"
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route"
import { consoleOverviewShortcut, consoleSectionDetails, consoleSectionShortcut, groupConsoleSections } from "../sections"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";

interface ConsoleSearchFilter {
  search?: string;
}

interface ConsoleSearchItem {
  agentName?: string;
  context: string;
  excerpt?: string;
  id: string;
  status: AgentInvocationListItem["status"];
  updatedAt: string;
}

interface ConsoleDefinitionSearchItem {
  details: ConsoleSectionDetails
  file: string
  name: string
  source: string
}

interface ConsoleKVSearchItem {
  key: string
  store: string
}

declare global {
  interface ViteHubCollectionMap {
    "vitehub-console-search": Collection<
      ConsoleSearchItem,
      ConsoleSearchFilter,
      ConsoleSearchFilter
    >;
  }
}

const props = defineProps<{
  /** Commands of the current page. Search lists them first, in an "Actions" group. */
  actions?: CommandPaletteItem[]
  agentNames?: string[]
  agentsBase: string
  definitionsBase: string
  kvBase: string
  searchBase: string
  sectionsBase: string
}>()
const route = useRoute()
const router = useRouter()
// The standalone Console provides its appearance. In a Nuxt host, UDashboardSearch shows the host color mode instead.
const appearance = inject(consoleAppearanceKey, undefined)
const open = ref(false)
const searchTerm = ref("")
const debouncedSearchTerm = ref("")
const sections = ref<ConsoleSectionId[]>([])
const installedNavigation = shallowRef<ConsoleNavigation>()
const discoveredAgentNames = ref<string[]>([])
const definitionItems = ref<ConsoleDefinitionSearchItem[]>([])
const kvItems = ref<ConsoleKVSearchItem[]>([])
const kvSearchTruncated = ref(false)
const navigationLoading = ref(true)
const navigationError = ref<unknown>()
const sessionSearchEnabled = ref(false)
let navigationRequest: AbortController | undefined
let sessionRequest: AbortController | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
const emit = defineEmits<{ selectPage: []; selectSession: [] }>()

const agentsEnabled = computed(() => sections.value.includes("agents"));
const availableAgentNames = computed(() => props.agentNames ?? discoveredAgentNames.value);
const inactiveSearchFilter: ConsoleSearchFilter = {};
const searchFilter = computed<ConsoleSearchFilter>(() => {
  if (!agentsEnabled.value || !sessionSearchEnabled.value) return inactiveSearchFilter;
  return debouncedSearchTerm.value ? { search: debouncedSearchTerm.value } : {};
});
const sessionSearch = useCollection("vitehub-console-search", {
  filter: searchFilter,
  immediate: false,
  limit: 12,
  request: async (_endpoint, options) => {
    const controller = new AbortController()
    sessionRequest = controller
    const abort = () => controller.abort()
    options.signal?.addEventListener("abort", abort, { once: true })
    try {
      return await requestConsole(props.searchBase, { ...options, signal: controller.signal })
    }
    finally {
      options.signal?.removeEventListener("abort", abort)
      if (sessionRequest === controller) sessionRequest = undefined
    }
  },
});
const sessionItems = computed<CommandPaletteItem[]>(() =>
  sessionSearch.pending.value
    ? []
    : sessionSearch.items.value.map((item) => ({
        description: itemDescription(item),
        disabled: !item.agentName,
        icon: "i-ph-chat-text-light",
        label: item.excerpt || (item.agentName ? `${item.agentName} session` : "Agent Invocation"),
        onSelect: () => selectSession(item),
      })),
)
const definitionSearchItems = computed<CommandPaletteItem[]>(() =>
  definitionItems.value.map(item => ({
    description: `${item.details.label.slice(0, -1)} · ${item.file}`,
    icon: item.details.icon,
    label: item.name,
    onSelect: () => selectDefinition(item),
  })),
)
const kvSearchItems = computed<CommandPaletteItem[]>(() =>
  kvItems.value.map(item => ({
    description: item.store,
    icon: consoleSectionDetails.kv.icon,
    label: item.key || "(empty key)",
    onSelect: () => selectKVKey(item),
  })),
)
const paletteError = computed(() => navigationError.value || sessionSearch.error.value)
const groups = computed<CommandPaletteGroup[]>(() => [
  ...(paletteError.value
    ? [{
        id: "error",
        items: [{
          description: errorMessage(paletteError.value),
          disabled: true,
          icon: "i-ph-cloud-slash-light",
          label: "Could not load Console search",
        }],
        ignoreFilter: true,
        label: "Search status",
      }]
    : []),
  ...(props.actions?.length
    ? [{ id: "actions", items: props.actions, label: "Actions" }]
    : []),
  {
    id: "go-to",
    items: [
      {
        icon: "i-ph-squares-four-light",
        kbds: [...consoleOverviewShortcut],
        label: "Overview",
        onSelect: () => selectPage("vitehub-console"),
      },
      // Sections follow the rail order.
      ...groupConsoleSections(sections.value.map(id => ({ id }))).flat().flatMap(({ id: section }) => {
        const details = resolveConsoleSectionDetails(installedNavigation.value, section)
        const shortcut = consoleSectionShortcut(section)
        return details
          ? [{
              icon: details.icon,
              ...(shortcut ? { kbds: [...shortcut] } : {}),
              label: details.label,
              onSelect: () => selectPage(details.routeName),
            }]
          : []
      }),
    ],
    label: "Go to",
  },
  ...(agentsEnabled.value && availableAgentNames.value.length
    ? [{
        id: "agents",
        items: availableAgentNames.value.map(name => ({
          icon: "i-ph-robot-light",
          label: name,
          onSelect: () => selectAgent(name),
        })),
        label: "Agents",
      }]
    : []),
  ...(definitionSearchItems.value.length
    ? [{ id: "definitions", items: definitionSearchItems.value, label: "Definitions" }]
    : []),
  ...(kvSearchItems.value.length
    ? [{
        id: "kv",
        items: kvSearchItems.value,
        label: "KV keys",
      }]
    : []),
  ...(kvSearchTruncated.value
    ? [{
        id: "kv-status",
        ignoreFilter: true,
        items: [{ disabled: true, icon: "i-ph-warning-light", label: "More matching keys may exist" }],
        label: "KV status",
      }]
    : []),
  ...(agentsEnabled.value
    ? [
        {
          id: "sessions",
          ignoreFilter: true,
          items: sessionItems.value,
          label: debouncedSearchTerm.value ? "Sessions" : "Recent sessions",
        },
      ]
    : []),
  ...(appearance
    ? [{
        id: "appearance",
        items: consoleAppearances.map(option => ({
          active: appearance.preference.value === option,
          icon: consoleAppearanceOptions[option].icon,
          label: consoleAppearanceOptions[option].label,
          onSelect: () => appearance.select(option),
        })),
        label: "Appearance",
      }]
    : []),
])
const loading = computed(() =>
  navigationLoading.value || (agentsEnabled.value && sessionSearch.pending.value),
)

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error
    ? error.message
    : error
      ? "The console could not load this data."
      : undefined;
}

function itemDescription(item: ConsoleSearchItem): string {
  const updatedAt = new Date(item.updatedAt).valueOf();
  const age = Number.isFinite(updatedAt)
    ? `${relativeDuration(Math.max(0, Date.now() - updatedAt))} ago`
    : undefined;
  return [item.agentName, item.status, age, item.excerpt ? undefined : item.context]
    .filter(Boolean)
    .join(" · ");
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

async function loadContent(installed: ConsoleSectionId[], signal: AbortSignal): Promise<void> {
  const definitionSections = installed.flatMap((section) => {
    const details = resolveConsoleSectionDetails(installedNavigation.value, section)
    const catalog = section === "databases"
      || installedNavigation.value?.contributions[section]?.view.kind === "definition-catalog"
    return details && catalog ? [{ details, section }] : []
  })
  const catalogs = await Promise.all(definitionSections.map(async ({ details, section }) => ({
    details,
    value: record(await requestConsole(props.definitionsBase, {
      query: { section },
      signal,
    })),
  })))
  definitionItems.value = catalogs.flatMap(({ details, value }) =>
    Array.isArray(value?.definitions)
      ? value.definitions.flatMap((entry) => {
          const definition = record(entry)
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
          return typeof definition?.name === "string"
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
            && typeof definition.file === "string"
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
            && typeof definition.source === "string"
            ? [{ details, file: definition.file, name: definition.name, source: definition.source }]
            : []
        })
      : [],
  )

  if (installed.includes("kv")) {
    const query = { limit: 50 }
    const first = record(await requestConsole(props.kvBase, { query, signal }))
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    const firstStore = typeof first?.store === "string" ? first.store : "default"
    const stores = strings(first?.stores)
    const remainingStores = stores.filter(store => store !== firstStore)
    const storesWithFirstPage = [firstStore, ...remainingStores]
    const results = await Promise.all(storesWithFirstPage.map((store, index) =>
      loadConsoleKVPages(props.kvBase, store, signal, index === 0 ? first : undefined, {
        limit: query.limit,
        maxPages: 10,
      }),
    ))
    kvItems.value = results.flatMap(({ pages }, index) =>
      pages.flatMap(value => strings(value.keys).map(key => ({ key, store: storesWithFirstPage[index]! }))),
    )
    kvSearchTruncated.value = results.some(result => result.truncated)
  }
  else kvSearchTruncated.value = false
}

async function loadNavigation(discoverContent = false): Promise<void> {
  navigationRequest?.abort()
  const controller = new AbortController()
  navigationRequest = controller
  navigationLoading.value = true
  if (discoverContent) {
    discoveredAgentNames.value = []
    definitionItems.value = []
    kvItems.value = []
    kvSearchTruncated.value = false
  }
  try {
    const navigation = await loadConsoleNavigation(props.sectionsBase)
    if (!navigation) throw viteHubErrorDiagnostics.VITE_HUB_R0106({ message: "Could not load Console navigation." })
    const installed = navigation.sections
    controller.signal.throwIfAborted()
    if (navigationRequest !== controller) return
    installedNavigation.value = navigation
    sections.value = [...new Set(installed)]

    if (discoverContent && props.agentNames === undefined && installed.includes("agents")) {
      const agentsValue = record(await requestConsole(props.agentsBase, { signal: controller.signal }))
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate every Agent identity.
      const names = Array.isArray(agentsValue?.agents)
        ? agentsValue.agents.filter((name): name is string => {
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate every Agent identity.
            return typeof name === "string" && Boolean(name.trim());
          })
        : [];
      if (navigationRequest !== controller) return;
      discoveredAgentNames.value = [...new Set(names)];
    }
    if (discoverContent) await loadContent(installed, controller.signal)
    navigationError.value = undefined
  }
  catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return
    if (navigationRequest === controller) navigationError.value = error
  }
  finally {
    if (navigationRequest === controller) {
      navigationRequest = undefined;
      navigationLoading.value = false;
    }
  }
}

async function selectPage(routeName: string): Promise<void> {
  open.value = false;
  emit("selectPage");
  await router.push({ name: resolveConsoleRouteName(route.name, routeName) });
}

async function selectAgent(name: string): Promise<void> {
  open.value = false;
  emit("selectSession");
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
    params: { agent: encodeAgentRouteParam(name) },
  });
}

async function selectDefinition(item: ConsoleDefinitionSearchItem): Promise<void> {
  open.value = false
  await router.push({
    name: resolveConsoleRouteName(route.name, item.details.routeName),
    ...(item.details.routeName === consoleSectionDetails.databases.routeName
      ? { params: { database: item.name } }
      : { query: { definition: item.name } }),
  })
}

async function selectKVKey(item: ConsoleKVSearchItem): Promise<void> {
  open.value = false
  await router.push({
    name: resolveConsoleRouteName(route.name, consoleSectionDetails.kv.routeName),
    query: { key: item.key, store: item.store },
  })
}

async function selectSession(item: ConsoleSearchItem): Promise<void> {
  if (!item.agentName) return;
  open.value = false;
  emit("selectSession");
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
    params: { agent: encodeAgentRouteParam(item.agentName), invocation: item.id },
  });
}

watch(searchTerm, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = undefined
  if (!open.value) return
  searchTimer = setTimeout(() => {
    searchTimer = undefined
    if (open.value) debouncedSearchTerm.value = value.trim()
  }, 150)
})

watch(open, async (value) => {
  if (!value) {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = undefined
    navigationRequest?.abort()
    sessionRequest?.abort()
    return
  }
  await loadNavigation(true);
  if (!open.value) return
  if (!agentsEnabled.value) return;
  const nextSearchTerm = searchTerm.value.trim()
  const searchChanged = debouncedSearchTerm.value !== nextSearchTerm
  debouncedSearchTerm.value = nextSearchTerm
  if (!sessionSearchEnabled.value) sessionSearchEnabled.value = true
  else if (!searchChanged) await sessionSearch.refresh()
});

// `/` opens search, as in GitHub and Linear. It does not run while an input has focus.
defineShortcuts({
  "/": () => {
    open.value = true
  },
})

onMounted(() => void loadNavigation());

onBeforeUnmount(() => {
  navigationRequest?.abort();
  sessionRequest?.abort();
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <UDashboardSearch
    v-model:open="open"
    v-model:search-term="searchTerm"
    :groups="groups"
    :loading="loading"
    description="Run actions and search pages, Agents, definitions, KV keys, and sessions."
    placeholder="Search the Console…"
    preserve-group-order
    title="Search console"
    :ui="{ root: 'flex-1', content: 'flex-1', footer: 'px-3 py-2' }"
  >
    <template #empty="{ searchTerm: value }">
      <div class="grid justify-items-center gap-2 px-6 py-10 text-center">
        <UIcon
          name="i-ph-magnifying-glass-minus-light"
          class="size-6 text-dimmed"
        />
        <p class="text-sm font-medium text-highlighted">
          No matches
        </p>
        <p class="text-xs text-muted">
          {{ value.trim() ? "Try a page, Agent, definition, key, or session." : "No Console results are available yet." }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="vitehub-console__search-footer">
        <span><UKbd value="arrowup" size="sm" /><UKbd value="arrowdown" size="sm" /> Navigate</span>
        <span><UKbd value="enter" size="sm" /> Select</span>
        <span><UKbd value="escape" size="sm" /> Close</span>
        <span class="vitehub-console__search-footer-end"><UKbd value="g" size="sm" /> then a key to go to a page</span>
      </div>
    </template>
  </UDashboardSearch>
</template>

<style>
.vitehub-console__search-footer {
  align-items: center;
  color: var(--ui-text-dimmed);
  display: flex;
  flex-wrap: wrap;
  font-size: 0.75rem;
  gap: 1rem;
  width: 100%;
}

.vitehub-console__search-footer > span {
  align-items: center;
  display: inline-flex;
  gap: 0.25rem;
}

.vitehub-console__search-footer-end {
  margin-inline-start: auto;
}
</style>
