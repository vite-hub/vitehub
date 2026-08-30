<script setup lang="ts">
import { useCollection } from "vite-hub/source/client"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"

import type { CommandPaletteGroup, CommandPaletteItem } from "@nuxt/ui"
import type { Collection } from "@vite-hub/source"
import type { AgentInvocationListItem } from "@vite-hub/ui"
import type { ConsoleSectionId } from "../sections"
import { loadConsoleKVPages, requestConsole } from "../client/request"
import { loadConsoleNavigation } from "../client/sections"
import { relativeDuration } from "../client/time"
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route"
import { consoleSectionDetails } from "../sections"

interface ConsoleSearchFilter {
  search?: string
}

interface ConsoleSearchItem {
  agentName?: string
  context: string
  excerpt?: string
  id: string
  status: AgentInvocationListItem["status"]
  updatedAt: string
}

interface ConsoleDefinitionSearchItem {
  file: string
  name: string
  section: "queues" | "workflows"
  source: string
}

interface ConsoleKVSearchItem {
  key: string
  store: string
}

declare global {
  interface ViteHubCollectionMap {
    "vitehub-console-search": Collection<ConsoleSearchItem, ConsoleSearchFilter, ConsoleSearchFilter>
  }
}

const props = defineProps<{
  agentNames?: string[]
  agentsBase: string
  definitionsBase: string
  kvBase: string
  searchBase: string
  sectionsBase: string
}>()
const route = useRoute()
const router = useRouter()
const open = ref(false)
const searchTerm = ref("")
const debouncedSearchTerm = ref("")
const sections = ref<ConsoleSectionId[]>([])
const discoveredAgentNames = ref<string[]>([])
const definitionItems = ref<ConsoleDefinitionSearchItem[]>([])
const kvItems = ref<ConsoleKVSearchItem[]>([])
const kvSearchTruncated = ref(false)
const navigationLoading = ref(true)
const navigationError = ref<unknown>()
const sessionSearchEnabled = ref(false)
let navigationRequest: AbortController | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined

const agentsEnabled = computed(() => sections.value.includes("agents"))
const availableAgentNames = computed(() => props.agentNames ?? discoveredAgentNames.value)
const inactiveSearchFilter: ConsoleSearchFilter = {}
const searchFilter = computed<ConsoleSearchFilter>(() => {
  if (!agentsEnabled.value || !sessionSearchEnabled.value) return inactiveSearchFilter
  return debouncedSearchTerm.value ? { search: debouncedSearchTerm.value } : {}
})
const sessionSearch = useCollection("vitehub-console-search", {
  filter: searchFilter,
  immediate: false,
  limit: 12,
  request: (_endpoint, options) => requestConsole(props.searchBase, options),
})
const sessionItems = computed<CommandPaletteItem[]>(() =>
  sessionSearch.pending.value
    ? []
    : sessionSearch.items.value.map(item => ({
        description: itemDescription(item),
        disabled: !item.agentName,
        icon: "i-ph-chat-text-light",
        label: item.excerpt || (item.agentName ? `${item.agentName} session` : "Agent Invocation"),
        onSelect: () => selectSession(item),
      })),
)
const definitionSearchItems = computed<CommandPaletteItem[]>(() =>
  definitionItems.value.map(item => ({
    description: `${consoleSectionDetails[item.section].label.slice(0, -1)} · ${item.file}`,
    icon: consoleSectionDetails[item.section].icon,
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
  {
    id: "pages",
    items: [
      {
        icon: "i-ph-squares-four-light",
        label: "All primitives",
        onSelect: () => selectPage("vitehub-console"),
      },
      ...sections.value.map(section => ({
        icon: consoleSectionDetails[section].icon,
        label: consoleSectionDetails[section].label,
        onSelect: () => selectPage(consoleSectionDetails[section].routeName),
      })),
    ],
    label: "Pages",
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
  ...(kvSearchItems.value.length || kvSearchTruncated.value
    ? [{
        id: "kv",
        items: [
          ...kvSearchItems.value,
          ...(kvSearchTruncated.value
            ? [{ disabled: true, icon: "i-ph-warning-light", label: "More matching keys may exist" }]
            : []),
        ],
        label: "KV keys",
      }]
    : []),
  ...(agentsEnabled.value
    ? [{
        id: "sessions",
        ignoreFilter: true,
        items: sessionItems.value,
        label: debouncedSearchTerm.value ? "Sessions" : "Recent sessions",
      }]
    : []),
])
const loading = computed(() =>
  navigationLoading.value || (agentsEnabled.value && sessionSearch.pending.value),
)

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error
    ? error.message
    : error
      ? "The console could not load this data."
      : undefined
}

function itemDescription(item: ConsoleSearchItem): string {
  const updatedAt = new Date(item.updatedAt).valueOf()
  const age = Number.isFinite(updatedAt)
    ? `${relativeDuration(Math.max(0, Date.now() - updatedAt))} ago`
    : undefined
  return [item.agentName, item.status, age, item.excerpt ? undefined : item.context]
    .filter(Boolean)
    .join(" · ")
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

async function loadContent(installed: ConsoleSectionId[], signal: AbortSignal): Promise<void> {
  const definitionSections = installed.filter((section): section is "queues" | "workflows" =>
    section === "queues" || section === "workflows",
  )
  const catalogs = await Promise.all(definitionSections.map(async (section) => ({
    section,
    value: record(await requestConsole(props.definitionsBase, {
      query: { section },
      signal,
    })),
  })))
  definitionItems.value = catalogs.flatMap(({ section, value }) =>
    Array.isArray(value?.definitions)
      ? value.definitions.flatMap((entry) => {
          const definition = record(entry)
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
          return typeof definition?.name === "string"
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
            && typeof definition.file === "string"
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
            && typeof definition.source === "string"
            ? [{ file: definition.file, name: definition.name, section, source: definition.source }]
            : []
        })
      : [],
  )

  if (installed.includes("kv")) {
    const query = { limit: 50, prefix: debouncedSearchTerm.value }
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
        prefix: query.prefix,
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
  try {
    const navigation = await loadConsoleNavigation(props.sectionsBase)
    if (!navigation) throw new Error("Could not load Console navigation.")
    const installed = navigation.sections
    controller.signal.throwIfAborted()
    if (navigationRequest !== controller) return
    sections.value = [...new Set(installed)]

    if (discoverContent && props.agentNames === undefined && installed.includes("agents")) {
      const agentsValue = record(await requestConsole(props.agentsBase, { signal: controller.signal }))
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate every Agent identity.
      const names = Array.isArray(agentsValue?.agents)
        ? agentsValue.agents.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
        : []
      if (navigationRequest !== controller) return
      discoveredAgentNames.value = [...new Set(names)]
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
      navigationRequest = undefined
      navigationLoading.value = false
    }
  }
}

async function selectPage(routeName: string): Promise<void> {
  open.value = false
  await router.push({ name: resolveConsoleRouteName(route.name, routeName) })
}

async function selectAgent(name: string): Promise<void> {
  open.value = false
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
    params: { agent: encodeAgentRouteParam(name) },
  })
}

async function selectDefinition(item: ConsoleDefinitionSearchItem): Promise<void> {
  open.value = false
  await router.push({
    name: resolveConsoleRouteName(route.name, consoleSectionDetails[item.section].routeName),
    query: { definition: item.name },
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
  if (!item.agentName) return
  open.value = false
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
    params: { agent: encodeAgentRouteParam(item.agentName), invocation: item.id },
  })
}

watch(searchTerm, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    debouncedSearchTerm.value = value.trim()
  }, 150)
})

watch(debouncedSearchTerm, () => {
  if (open.value) void loadNavigation(true)
})

watch(open, async (value) => {
  if (!value) return
  await loadNavigation(true)
  if (!agentsEnabled.value) return
  if (sessionSearchEnabled.value) await sessionSearch.refresh()
  else sessionSearchEnabled.value = true
})

onMounted(() => void loadNavigation())

onBeforeUnmount(() => {
  navigationRequest?.abort()
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <UDashboardSearch
    v-model:open="open"
    v-model:search-term="searchTerm"
    :groups="groups"
    :loading="loading"
    description="Search pages, Agents, definitions, KV keys, and sessions."
    placeholder="Search the Console…"
    preserve-group-order
    title="Search console"
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
  </UDashboardSearch>
</template>
