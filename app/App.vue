<script setup lang="ts">
import { AgentInvocationList, type AgentInvocationConfiguration, type AgentInvocationListItem, type AgentInvocationView } from '@vite-hub/ui'
import { useAgentInvocation, useAgentInvocations } from 'vite-hub/agent/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invocationContext, invocationProject, invocationSummary, invocationTitle } from './invocation-display'
import ProviderLogo from './components/ProviderLogo.vue'
import SessionInspector from './components/SessionInspector.vue'
import SessionThread from './components/SessionThread.vue'
import HealthPage from './components/HealthPage.vue'

import type { SplitterItem } from '@nuxt/ui'
import type { AgentInvocationRecordStatus } from 'vite-hub/agent'

const linkedInvocationId = typeof window === 'undefined' ? undefined : new URLSearchParams(window.location.search).get('invocation') || undefined
const selectedId = ref<string | undefined>(linkedInvocationId)
const nowMs = ref(Date.now())
const query = ref('')
const debouncedQuery = ref('')
const sessionsOpen = ref(false)
const sessionsCollapsed = ref(false)
const detailsOpen = ref(false)
const inspectorMaximized = ref(false)
const activePage = ref<'health' | 'sessions'>('sessions')
type InspectorTab = 'details' | 'trace' | 'workspace'
const inspectorTab = ref<InspectorTab>('details')
const inspectorOpenViews = ref<InspectorTab[]>(['details'])
const inspectorOpenPaths = ref<string[]>([])
const inspectorSelectedPath = ref<string>()
const inspectorActiveSurface = ref('view:details')
const sessionThread = ref<InstanceType<typeof SessionThread>>()
let clock: ReturnType<typeof setInterval> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined

const request = async <T,>(path: string, options: { signal?: AbortSignal }) => {
  const response = await fetch(path, { signal: options.signal })
  if (!response.ok) throw new Error(`Invocation request failed with status ${response.status}.`)
  return await response.json() as T
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
  provider: typeof invocation.annotations?.['agent.model.provider'] === 'string'
    ? invocation.annotations['agent.model.provider']
    : undefined,
  startedAt: invocation.startedAt,
  status: invocation.status,
  title: invocationTitle(invocation),
  updatedAt: invocation.updatedAt || invocation.startedAt || invocation.createdAt,
})))
const matchingDetail = computed(() => selected.value)
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
  { id: 'thread', slot: 'thread', minSize: 220, defaultSize: 680, sizeUnit: 'px', class: 'min-h-0 min-w-0 overflow-hidden' },
  { id: 'details', slot: 'details', minSize: 300, maxSize: 1080, defaultSize: 560, sizeUnit: 'px', class: 'min-h-0 min-w-0 overflow-hidden' },
]
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
  activePage.value = 'sessions'
  selectedId.value = id
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href)
    url.searchParams.set('invocation', id)
    window.history.replaceState(null, '', url)
  }
  sessionsOpen.value = false
}

function toggleInspector(target: 'details' | 'agent' | 'trace' | 'workspace') {
  const view: InspectorTab = target === 'agent' ? 'details' : target
  if (!inspectorOpenViews.value.includes(view)) inspectorOpenViews.value = [...inspectorOpenViews.value, view]
  inspectorTab.value = view
  inspectorSelectedPath.value = undefined
  inspectorActiveSurface.value = `view:${view}`
  detailsOpen.value = true
}

function showHealth() {
  activePage.value = 'health'
  detailsOpen.value = false
  inspectorMaximized.value = false
  sessionsOpen.value = false
}

function showSessions() {
  activePage.value = 'sessions'
}

function toggleRightPanel() {
  detailsOpen.value = !detailsOpen.value
  if (detailsOpen.value && !inspectorActiveSurface.value) {
    if (!inspectorOpenViews.value.includes(inspectorTab.value)) inspectorOpenViews.value = [...inspectorOpenViews.value, inspectorTab.value]
    inspectorActiveSurface.value = `view:${inspectorTab.value}`
  }
  if (!detailsOpen.value) inspectorMaximized.value = false
}

function closeInspector() {
  detailsOpen.value = false
  inspectorMaximized.value = false
}

async function focusTraceActivity(activityId: string) {
  if (inspectorMaximized.value) inspectorMaximized.value = false
  await nextTick()
  sessionThread.value?.focusActivity(activityId)
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

watch(invocations, (next) => {
  if (next.length && !selectedId.value) selectedId.value = next[0]!.id
}, { immediate: true })

watch(selected, (next) => {
  if (next && selectedId.value !== next.id) selectInvocation(next.id)
})

watch(selectedId, () => {
  inspectorTab.value = 'details'
  inspectorOpenViews.value = ['details']
  inspectorOpenPaths.value = []
  inspectorSelectedPath.value = undefined
  inspectorActiveSurface.value = 'view:details'
  inspectorMaximized.value = false
})

watch(query, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { debouncedQuery.value = value.trim() }, 250)
})

onMounted(() => {
  clock = setInterval(() => { nowMs.value = Date.now() }, 1_000)
})

onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
  if (searchTimer) clearTimeout(searchTimer)
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
        :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'px-2 py-1' }"
        collapsible
        resizable
      >
        <template #header="{ collapsed }">
          <button type="button" class="flex min-w-0 items-center gap-2.5 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-primary" @click="sessionsCollapsed = false">
            <span class="flex size-7 shrink-0 items-center justify-center" aria-hidden="true"><UIcon name="i-lucide-box" class="size-4 text-muted" /></span>
            <span v-if="!collapsed" class="grid min-w-0 leading-none"><small class="text-[10px] font-bold uppercase tracking-[.12em] text-muted">ViteHub</small><strong class="mt-1 truncate text-sm font-semibold text-highlighted">Babysitter</strong></span>
          </button>
        </template>

        <template #default="{ collapsed }">
          <div v-if="!collapsed" class="flex shrink-0 items-center gap-1 px-2 pb-2 pt-1">
            <UInput v-model="query" class="min-w-0 flex-1" icon="i-lucide-search" placeholder="Search sessions" size="sm" variant="none" :ui="{ base: 'bg-transparent hover:bg-elevated/60 focus:bg-elevated/60' }" />
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
            :selected-id="activePage === 'sessions' ? selectedId : undefined"
            @end-reached="loadOlder()"
            @select="selectInvocation($event.id)"
          >
            <template #empty><UEmpty class="px-3" icon="i-lucide-message-square-dashed" :title="debouncedQuery ? 'No matching sessions' : 'No sessions yet'" :description="debouncedQuery ? 'Try a different search.' : 'The first Agent Invocation will appear here.'" /></template>
            <template #harness="{ item }"><ProviderLogo :provider="item.provider" /></template>
          </AgentInvocationList>
        </template>

        <template #footer="{ collapsed, collapse }">
          <div class="flex items-center gap-1">
            <UTooltip :text="activePage === 'health' ? 'Back to sessions' : 'Health'" :content="{ side: 'top' }">
              <UButton :icon="activePage === 'health' ? 'i-lucide-arrow-left' : 'i-lucide-chart-no-axes-column'" color="neutral" variant="ghost" size="xs" :aria-label="activePage === 'health' ? 'Back to sessions' : 'Health'" @click="activePage === 'health' ? showSessions() : showHealth()" />
            </UTooltip>
            <UTooltip :text="collapsed ? 'Show sessions' : 'Hide sessions'">
              <UButton class="max-lg:hidden" :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" color="neutral" variant="ghost" size="xs" :aria-label="collapsed ? 'Show sessions' : 'Hide sessions'" @click="collapse(!collapsed)" />
            </UTooltip>
          </div>
        </template>
      </UDashboardSidebar>

      <UDashboardPanel id="babysitter-session" :ui="{ body: 'min-h-0 overflow-hidden !gap-0 !p-0 sm:!gap-0 sm:!p-0' }">
        <template #body>
          <div class="h-full min-h-0 overflow-hidden">
            <HealthPage v-if="activePage === 'health'" />
            <SessionInspector v-else-if="detailsOpen && inspectorMaximized && invocationView" v-model:active-surface="inspectorActiveSurface" v-model:open-paths="inspectorOpenPaths" v-model:open-views="inspectorOpenViews" v-model:selected-path="inspectorSelectedPath" v-model:tab="inspectorTab" :invocation="invocationView" :maximized="true" class="h-full" @close="closeInspector" @focus-activity="focusTraceActivity" @toggle-maximized="inspectorMaximized = false" />
            <USplitter v-else-if="detailsOpen && invocationView" id="babysitter-session-layout" auto-save-id="babysitter-session-layout-v2" :items="splitterItems" class="h-full min-h-0 overflow-hidden">
                <template #thread><SessionThread ref="sessionThread" :details-open="detailsOpen" :error-message="detailErrorMessage" :inspector-tab="inspectorTab" :invocation="invocationView" :loading="loadingDetail" :pull-request-url="pullRequestUrl" @inspect="toggleInspector" @refresh="refresh" @toggle-panel="toggleRightPanel" /></template>
                <template #details><SessionInspector v-model:active-surface="inspectorActiveSurface" v-model:open-paths="inspectorOpenPaths" v-model:open-views="inspectorOpenViews" v-model:selected-path="inspectorSelectedPath" v-model:tab="inspectorTab" :invocation="invocationView" class="h-full" @close="closeInspector" @focus-activity="focusTraceActivity" @toggle-maximized="inspectorMaximized = true" /></template>
                <template #resize-handle><span class="pointer-events-none absolute inset-y-0 start-1/2 w-px -translate-x-1/2 bg-(--ui-border) transition-colors group-hover:bg-primary group-focus-visible:bg-primary" /></template>
            </USplitter>
            <SessionThread v-else ref="sessionThread" :details-open="detailsOpen" :error-message="detailErrorMessage" :inspector-tab="inspectorTab" :invocation="invocationView" :loading="loadingDetail" :pull-request-url="pullRequestUrl" @inspect="toggleInspector" @refresh="refresh" @toggle-panel="toggleRightPanel" />
          </div>
        </template>
      </UDashboardPanel>
    </UDashboardGroup>
  </UApp>
</template>
