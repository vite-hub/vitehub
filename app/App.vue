<script setup lang="ts">
import { AgentInvocation, AgentInvocationInspector, AgentInvocationList, type AgentInvocationConfiguration, type AgentInvocationListItem, type AgentInvocationView } from '@vite-hub/ui'
import { useAgentInvocation, useAgentInvocations } from 'vite-hub/agent/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { syncFreshness } from './freshness'
import { invocationContext, invocationProject, invocationSummary, invocationTitle } from './invocation-display'

import type { SplitterItem } from '@nuxt/ui'
import type { AgentInvocationRecordStatus } from 'vite-hub/agent'

const selectedId = ref<string>()
const lastSuccessfulPollAt = ref<Date>()
const nowMs = ref(Date.now())
const query = ref('')
const debouncedQuery = ref('')
const sessionsOpen = ref(false)
const sessionsCollapsed = ref(false)
const detailsOpen = ref(false)
const useDesktopInspector = ref(false)
let clock: ReturnType<typeof setInterval> | undefined
let media: MediaQueryList | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined

const request = async <T,>(path: string, options: { signal?: AbortSignal }) => {
  const response = await fetch(path, { signal: options.signal })
  if (!response.ok) throw new Error(`Invocation request failed with status ${response.status}.`)
  const result = await response.json() as T
  lastSuccessfulPollAt.value = new Date()
  return result
}

const listQuery = computed(() => ({
  limit: 50,
  ...(debouncedQuery.value ? { search: debouncedQuery.value } : {}),
}))
const list = useAgentInvocations({ pollInterval: 5_000, query: listQuery, request })
const detail = useAgentInvocation(selectedId, { pollInterval: 5_000, request })
const invocations = list.invocations
const selected = detail.invocation
const observations = detail.observations
const loadingList = list.isLoading
const loadingMore = list.isLoadingMore
const listCursor = list.cursor
const loadingDetail = detail.isLoading
const listErrorMessage = computed(() => errorMessage(list.error.value))
const detailErrorMessage = computed(() => errorMessage(detail.error.value))
const sessionItems = computed<AgentInvocationListItem[]>(() => invocations.value.map(invocation => ({
  agent: invocation.agentName,
  context: invocationContext(invocation),
  description: invocation.error?.message ? invocationSummary(invocation) : undefined,
  id: invocation.id,
  project: invocationProject(invocation),
  startedAt: invocation.startedAt,
  status: invocation.status,
  title: invocationTitle(invocation),
  updatedAt: invocation.updatedAt || invocation.startedAt || invocation.createdAt,
})))
const matchingDetail = computed(() => selected.value?.id === selectedId.value ? selected.value : undefined)
const pullRequestUrl = computed(() => {
  const value = matchingDetail.value?.annotations?.['github.url']
  return typeof value === 'string' ? value : undefined
})
const invocationView = computed<AgentInvocationView | undefined>(() => {
  if (!matchingDetail.value) return
  const persistedConfiguration = record(record(matchingDetail.value)?.configuration)
  const configuration = persistedConfiguration as AgentInvocationConfiguration | undefined ?? observedConfiguration(observations.value)
  return { ...matchingDetail.value, ...(configuration ? { configuration } : {}), observations: observations.value }
})
const splitterItems: SplitterItem[] = [
  { id: 'thread', slot: 'thread', minSize: 520, defaultSize: 820, sizeUnit: 'px', class: 'min-h-0 min-w-0 overflow-hidden' },
  { id: 'details', slot: 'details', minSize: 320, maxSize: 520, defaultSize: 380, sizeUnit: 'px', class: 'min-h-0 min-w-0 overflow-hidden' },
]
const syncState = computed(() => syncFreshness(lastSuccessfulPollAt.value?.valueOf(), nowMs.value))
const syncStale = computed(() => syncState.value.stale)
const syncLabel = computed(() => syncState.value.label)

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function observedConfiguration(entries: AgentInvocationView['observations']): AgentInvocationConfiguration | undefined {
  for (const entry of entries) {
    if (entry.name !== 'vitehub.agent.configured') continue
    const configuration = record(entry.attributes?.['vitehub.agent.configuration'])
    if (configuration) return configuration as AgentInvocationConfiguration
  }
}

async function refresh() {
  await Promise.all([list.refresh(), selectedId.value ? detail.refresh() : Promise.resolve()])
}

function loadOlder() {
  return list.loadMore()
}

function selectInvocation(id: string) {
  selectedId.value = id
  sessionsOpen.value = false
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : error ? 'Unable to load Agent Invocations.' : undefined
}

function statusIcon(status: AgentInvocationRecordStatus) {
  if (status === 'running') return 'i-lucide-loader-circle'
  if (status === 'completed') return 'i-lucide-check'
  if (status === 'failed') return 'i-lucide-x'
  if (status === 'cancelled') return 'i-lucide-ban'
  return 'i-lucide-clock-3'
}

function updateDesktop(event?: MediaQueryListEvent) {
  useDesktopInspector.value = event?.matches ?? media?.matches ?? false
}

watch(invocations, (next) => {
  if (!next.length) selectedId.value = undefined
  else if (!selectedId.value || !next.some(invocation => invocation.id === selectedId.value)) selectedId.value = next[0]!.id
}, { immediate: true })

watch(query, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { debouncedQuery.value = value.trim() }, 250)
})

onMounted(() => {
  media = window.matchMedia('(min-width: 1280px)')
  updateDesktop()
  media.addEventListener('change', updateDesktop)
  clock = setInterval(() => { nowMs.value = Date.now() }, 1_000)
})

onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
  if (searchTimer) clearTimeout(searchTimer)
  media?.removeEventListener('change', updateDesktop)
})
</script>

<template>
  <UApp>
    <UDashboardGroup class="babysitter-dashboard" unit="rem" storage-key="babysitter-dashboard">
      <UDashboardSidebar
        id="babysitter-sessions"
        v-model:open="sessionsOpen"
        v-model:collapsed="sessionsCollapsed"
        :default-size="16"
        :collapsed-size="4"
        :min-size="13"
        :max-size="22"
        :menu="{ title: 'Babysitter sessions', description: 'Browse read-only Agent Invocations.' }"
        :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'border-t border-default px-3 py-2' }"
        collapsible
        resizable
      >
        <template #header="{ collapsed }">
          <button type="button" class="flex min-w-0 items-center gap-2.5 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-primary" @click="sessionsCollapsed = false">
            <span class="grid size-7 shrink-0 grid-cols-3 items-end gap-0.5 rounded-md bg-highlighted p-1.5" aria-hidden="true"><i class="h-2/3 bg-inverted" /><i class="h-full bg-primary" /><i class="h-4/5 bg-inverted" /></span>
            <span v-if="!collapsed" class="grid min-w-0 leading-none"><small class="text-[10px] font-bold uppercase tracking-[.12em] text-muted">ViteHub</small><strong class="mt-1 truncate text-sm font-semibold text-highlighted">Babysitter</strong></span>
          </button>
        </template>

        <template #default="{ collapsed }">
          <div v-if="!collapsed" class="flex shrink-0 items-center gap-1 px-2 pb-2 pt-1">
            <UInput v-model="query" class="min-w-0 flex-1" icon="i-lucide-search" placeholder="Search sessions" size="sm" variant="none" :ui="{ base: 'bg-transparent hover:bg-elevated/60 focus:bg-elevated/60' }" />
            <UTooltip text="Refresh sessions"><UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" :disabled="loadingList || loadingDetail" aria-label="Refresh sessions" @click="refresh()" /></UTooltip>
          </div>
          <div v-if="!collapsed && listErrorMessage" class="px-2"><UAlert color="error" variant="subtle" icon="i-lucide-cloud-off" title="Could not load sessions" :description="listErrorMessage" /></div>
          <div v-else-if="!collapsed && loadingList && invocations.length === 0" class="grid gap-px px-2"><USkeleton v-for="index in 4" :key="index" class="h-[4.875rem] rounded-md" /></div>

          <div v-if="collapsed" class="min-h-0 flex-1 overflow-y-auto">
            <div class="grid gap-1 px-2 py-1">
              <UTooltip v-for="invocation in invocations" :key="invocation.id" :text="invocationTitle(invocation)" :content="{ side: 'right' }"><UButton :icon="statusIcon(invocation.status)" :color="invocation.status === 'failed' ? 'error' : 'neutral'" :variant="selectedId === invocation.id ? 'soft' : 'ghost'" block :aria-label="invocationTitle(invocation)" @click="selectInvocation(invocation.id)" /></UTooltip>
            </div>
          </div>
          <AgentInvocationList
            v-else
            class="min-h-0 flex-1 px-1 pb-3"
            :has-more="Boolean(listCursor)"
            :items="sessionItems"
            :loading="loadingMore"
            :now="nowMs"
            :selected-id="selectedId"
            @end-reached="loadOlder()"
            @select="selectInvocation($event.id)"
          >
            <template #empty><UEmpty class="px-3" icon="i-lucide-message-square-dashed" :title="debouncedQuery ? 'No matching sessions' : 'No sessions yet'" :description="debouncedQuery ? 'Try a different search.' : 'The first Agent Invocation will appear here.'" /></template>
            <template #harness="{ item }"><span v-if="item.agent" :title="`Agent: ${item.agent}`"><UIcon name="i-lucide-bot" class="size-3.5" /><span class="sr-only">Agent {{ item.agent }}</span></span></template>
          </AgentInvocationList>
        </template>

        <template #footer="{ collapsed, collapse }">
          <template v-if="!collapsed"><span class="flex items-center gap-1.5 text-xs text-muted"><UIcon name="i-lucide-lock-keyhole" class="size-3.5" />Read-only</span><span class="ml-auto text-xs" :class="syncStale ? 'text-warning' : 'text-dimmed'">{{ syncLabel }}</span></template>
          <UTooltip v-if="collapsed" text="Refresh sessions"><UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="xs" :disabled="loadingList || loadingDetail" aria-label="Refresh sessions" @click="refresh()" /></UTooltip>
          <UButton class="max-lg:hidden" :class="collapsed ? '' : 'ml-1'" :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" color="neutral" variant="ghost" size="xs" :aria-label="collapsed ? 'Show sessions' : 'Hide sessions'" @click="collapse(!collapsed)" />
        </template>
      </UDashboardSidebar>

      <UDashboardPanel id="babysitter-session" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
        <template #header>
          <UDashboardNavbar :title="invocationView ? invocationTitle(invocationView) : 'Babysitter'" :ui="{ root: 'border-b border-default', title: 'min-w-0 flex-1' }">
            <template #title>
              <div v-if="invocationView" class="flex min-w-0 items-center gap-2 text-sm">
                <UIcon name="i-lucide-folder" class="size-4 shrink-0 text-muted" />
                <span class="max-w-40 shrink-0 truncate font-normal text-muted">{{ invocationProject(invocationView) }}</span>
                <span class="text-dimmed" aria-hidden="true">/</span>
                <strong class="min-w-0 truncate font-medium text-highlighted">{{ invocationTitle(invocationView) }}</strong>
              </div>
              <span v-else class="text-sm font-medium">Babysitter</span>
            </template>
            <template #right>
              <UTooltip v-if="pullRequestUrl" text="Open pull request"><UButton :to="pullRequestUrl" target="_blank" icon="i-simple-icons-github" color="neutral" variant="ghost" size="sm" aria-label="Open pull request" /></UTooltip>
              <UTooltip text="Refresh session"><UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" :disabled="loadingList || loadingDetail" aria-label="Refresh session" @click="refresh()" /></UTooltip>
              <UTooltip v-if="invocationView" text="Session details"><UButton icon="i-lucide-panel-right" color="neutral" :variant="detailsOpen ? 'soft' : 'ghost'" size="sm" aria-label="Session details" :aria-pressed="detailsOpen" @click="detailsOpen = !detailsOpen" /></UTooltip>
            </template>
          </UDashboardNavbar>
        </template>

        <template #body>
          <div class="h-full min-h-0 overflow-hidden" aria-live="polite">
            <UEmpty v-if="detailErrorMessage" class="h-full" icon="i-lucide-cloud-off" title="Could not load this session" :description="detailErrorMessage" :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: refresh }]" />
            <div v-else-if="loadingDetail && !invocationView" class="flex h-full items-center justify-center"><UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" /></div>
            <template v-else-if="invocationView">
              <USplitter v-if="useDesktopInspector && detailsOpen" id="babysitter-session-layout" auto-save-id="babysitter-session-layout" :items="splitterItems" class="h-full min-h-0 overflow-hidden">
                <template #thread><AgentInvocation :header="false" :invocation="invocationView" class="h-full" /></template>
                <template #details><AgentInvocationInspector :invocation="invocationView" class="h-full"><template #actions><UButton icon="i-lucide-panel-right-close" color="neutral" variant="ghost" size="xs" aria-label="Close session details" @click="detailsOpen = false" /></template></AgentInvocationInspector></template>
                <template #resize-handle><span class="pointer-events-none absolute inset-y-0 start-1/2 w-px -translate-x-1/2 bg-(--ui-border) transition-colors group-hover:bg-primary group-focus-visible:bg-primary" /></template>
              </USplitter>
              <AgentInvocation v-else :header="false" :invocation="invocationView" class="h-full" />
              <USlideover v-if="!useDesktopInspector" v-model:open="detailsOpen" side="right" :ui="{ content: 'w-full max-w-sm p-0' }"><template #content><AgentInvocationInspector :invocation="invocationView" class="h-full"><template #actions><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="Close session details" @click="detailsOpen = false" /></template></AgentInvocationInspector></template></USlideover>
            </template>
            <div v-else class="flex h-full items-center justify-center text-sm text-muted">Select a session to inspect its work.</div>
          </div>
        </template>
      </UDashboardPanel>
    </UDashboardGroup>
  </UApp>
</template>
