<script setup lang="ts">
import { useCollection } from "vite-hub/source/client"
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"

import type { CommandPaletteGroup, CommandPaletteItem } from "@nuxt/ui"
import type { Collection } from "@vite-hub/source"
import type { AgentInvocationListItem } from "@vite-hub/ui"
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route"
import { requestConsole } from "../client/request"
import { relativeDuration } from "../client/time"

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

const props = defineProps<{ agentNames: string[], searchBase: string }>()
const route = useRoute()
const router = useRouter()
const open = ref(false)
const searchTerm = ref("")
const debouncedSearchTerm = ref("")
let searchTimer: ReturnType<typeof setTimeout> | undefined

const searchFilter = computed<ConsoleSearchFilter>(() =>
  debouncedSearchTerm.value ? { search: debouncedSearchTerm.value } : {},
)
const sessionSearch = useCollection("vitehub-console-search", {
  filter: searchFilter,
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
    id: "agents",
    items: props.agentNames.map(name => ({
      icon: "i-lucide-bot",
      label: name,
      onSelect: () => selectAgent(name),
    })),
    label: "Agents",
  },
  {
    id: "sessions",
    ignoreFilter: true,
    items: sessionItems.value,
    label: debouncedSearchTerm.value ? "Sessions" : "Recent sessions",
  },
])

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

watch(open, (value) => {
  if (value) void sessionSearch.refresh()
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <UDashboardSearch
    v-model:open="open"
    v-model:search-term="searchTerm"
    :groups="groups"
    :loading="sessionSearch.pending.value"
    placeholder="Search sessions and Agents…"
    preserve-group-order
  >
    <template #empty="{ searchTerm: value }">
      <div class="grid justify-items-center gap-2 px-6 py-10 text-center">
        <UIcon
          :name="sessionSearch.error.value ? 'i-lucide-cloud-off' : 'i-lucide-search-x'"
          class="size-6 text-dimmed"
        />
        <p class="text-sm font-medium text-highlighted">
          {{ sessionSearch.error.value ? "Could not search sessions" : value.trim() ? "No matching sessions" : "No sessions yet" }}
        </p>
        <p class="text-xs text-muted">
          {{ sessionSearch.error.value ? errorMessage(sessionSearch.error.value) : value.trim() ? "Try another phrase from the session." : "Agent Invocations will appear here." }}
        </p>
      </div>
    </template>
  </UDashboardSearch>
</template>
