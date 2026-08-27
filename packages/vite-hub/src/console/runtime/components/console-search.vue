<script setup lang="ts">
import { useCollection } from "vite-hub/source/client"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"

import type { CommandPaletteGroup, CommandPaletteItem } from "@nuxt/ui"
import type { Collection } from "@vite-hub/source"
import type { AgentInvocationListItem } from "@vite-hub/ui"
import type { ConsoleSectionId } from "../sections"
import { requestConsole } from "../client/request"
import { relativeDuration } from "../client/time"
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route"
import { consoleSectionDetails, isConsoleSectionId } from "../sections"

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

declare global {
  interface ViteHubCollectionMap {
    "vitehub-console-search": Collection<ConsoleSearchItem, ConsoleSearchFilter, ConsoleSearchFilter>
  }
}

const props = defineProps<{
  agentNames?: string[]
  agentsBase: string
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
        icon: "i-lucide-message-square-text",
        label: item.excerpt || (item.agentName ? `${item.agentName} session` : "Agent Invocation"),
        onSelect: () => selectSession(item),
      })),
)
const groups = computed<CommandPaletteGroup[]>(() => [
  {
    id: "pages",
    items: [
      {
        icon: "i-lucide-layout-grid",
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
          icon: "i-lucide-bot",
          label: name,
          onSelect: () => selectAgent(name),
        })),
        label: "Agents",
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
const paletteError = computed(() => navigationError.value || sessionSearch.error.value)

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

async function loadNavigation(discoverAgents = false): Promise<void> {
  navigationRequest?.abort()
  const controller = new AbortController()
  navigationRequest = controller
  navigationLoading.value = true
  try {
    const sectionsValue = record(await requestConsole(props.sectionsBase, { signal: controller.signal }))
    const installed = Array.isArray(sectionsValue?.sections)
      ? sectionsValue.sections.filter(isConsoleSectionId)
      : []
    if (navigationRequest !== controller) return
    sections.value = [...new Set(installed)]

    if (discoverAgents && props.agentNames === undefined && installed.includes("agents")) {
      const agentsValue = record(await requestConsole(props.agentsBase, { signal: controller.signal }))
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON, so validate every Agent identity.
      const names = Array.isArray(agentsValue?.agents)
        ? agentsValue.agents.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
        : []
      if (navigationRequest !== controller) return
      discoveredAgentNames.value = [...new Set(names)]
    }
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
    placeholder="Search pages, Agents, and sessions…"
    preserve-group-order
  >
    <template #empty="{ searchTerm: value }">
      <div class="grid justify-items-center gap-2 px-6 py-10 text-center">
        <UIcon
          :name="paletteError ? 'i-lucide-cloud-off' : 'i-lucide-search-x'"
          class="size-6 text-dimmed"
        />
        <p class="text-sm font-medium text-highlighted">
          {{ paletteError ? "Could not load Console search" : "No matches" }}
        </p>
        <p class="text-xs text-muted">
          {{ paletteError ? errorMessage(paletteError) : value.trim() ? "Try a page, Agent, or phrase from a session." : "No Console results are available yet." }}
        </p>
      </div>
    </template>
  </UDashboardSearch>
</template>
