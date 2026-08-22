<script setup lang="ts">
import { AgentInvocation, AgentInvocationInspector, type AgentInvocationConfiguration, type AgentInvocationView } from '@vite-hub/ui'
import { useAgentInvocation, useAgentInvocations } from 'vite-hub/agent/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isRunningStale, syncFreshness } from './freshness'
import { invocationContext, invocationSummary, invocationTitle } from './invocation-display'

import type { SplitterItem } from '@nuxt/ui'
import type { AgentInvocationRecordStatus, AgentInvocationSummary } from 'vite-hub/agent'

const selectedId = ref<string>()
const lastSuccessfulPollAt = ref<Date>()
const nowMs = ref(Date.now())
const sessionsOpen = ref(false)
const sessionsCollapsed = ref(false)
const detailsOpen = ref(false)
const isDesktop = ref(false)
let clock: ReturnType<typeof setInterval> | undefined
let media: MediaQueryList | undefined

const request = async <T,>(path: string, options: { signal?: AbortSignal }) => {
  const response = await fetch(path, { signal: options.signal })
  if (!response.ok) throw new Error(`Invocation request failed with status ${response.status}.`)
  const result = await response.json() as T
  lastSuccessfulPollAt.value = new Date()
  return result
}

const list = useAgentInvocations({ pollInterval: 5_000, request })
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
const matchingDetail = computed(() => selected.value?.id === selectedId.value ? selected.value : undefined)
const invocationView = computed<AgentInvocationView | undefined>(() => {
  if (!matchingDetail.value) return
  const persistedConfiguration = record(record(matchingDetail.value)?.configuration)
  const configuration = persistedConfiguration as AgentInvocationConfiguration | undefined ?? observedConfiguration(observations.value)
  return { ...matchingDetail.value, ...(configuration ? { configuration } : {}), observations: observations.value }
})
const splitterItems = computed<SplitterItem[]>(() => detailsOpen.value
  ? [
      { id: 'thread', slot: 'thread', minSize: 52, defaultSize: 68, class: 'min-w-0' },
      { id: 'details', slot: 'details', minSize: 24, maxSize: 44, defaultSize: 32, class: 'min-w-0' },
    ]
  : [{ id: 'thread', slot: 'thread', minSize: 100, maxSize: 100, defaultSize: 100, class: 'min-w-0' }])
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

function statusLabel(status: AgentInvocationRecordStatus) {
  return ({ cancelled: 'Cancelled', completed: 'Completed', failed: 'Failed', pending: 'Queued', running: 'Working' } as const)[status]
}

function statusIcon(status: AgentInvocationRecordStatus) {
  if (status === 'running') return 'i-lucide-loader-circle'
  if (status === 'completed') return 'i-lucide-check'
  if (status === 'failed') return 'i-lucide-x'
  if (status === 'cancelled') return 'i-lucide-ban'
  return 'i-lucide-clock-3'
}

function statusColor(status: AgentInvocationRecordStatus) {
  if (status === 'running') return 'text-info'
  if (status === 'completed') return 'text-success'
  if (status === 'failed') return 'text-error'
  return 'text-dimmed'
}

function formatTime(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  const elapsed = nowMs.value - date.valueOf()
  if (elapsed < 60_000) return 'now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function invocationUpdatedAt(invocation: AgentInvocationSummary) {
  return invocation.updatedAt || invocation.startedAt || invocation.createdAt
}

function invocationStale(invocation: AgentInvocationSummary) {
  return isRunningStale(invocation.status, invocationUpdatedAt(invocation), nowMs.value)
}

function updateDesktop(event?: MediaQueryListEvent) {
  isDesktop.value = event?.matches ?? media?.matches ?? false
}

watch(invocations, (next) => {
  if (!next.length) selectedId.value = undefined
  else if (!selectedId.value || !next.some(invocation => invocation.id === selectedId.value)) selectedId.value = next[0]!.id
}, { immediate: true })

onMounted(() => {
  media = window.matchMedia('(min-width: 1024px)')
  updateDesktop()
  media.addEventListener('change', updateDesktop)
  clock = setInterval(() => { nowMs.value = Date.now() }, 1_000)
})

onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
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
        :default-size="21"
        :collapsed-size="4"
        :min-size="17"
        :max-size="28"
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
          <div v-if="!collapsed" class="flex items-end justify-between px-4 pb-3 pt-5"><div><span class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">Agent activity</span><h1 class="mt-1 text-lg font-semibold tracking-tight text-highlighted">Sessions</h1></div><span class="text-xs text-dimmed">{{ invocations.length }}</span></div>
          <div v-if="!collapsed && listErrorMessage" class="px-3"><UAlert color="error" variant="subtle" icon="i-lucide-cloud-off" title="Could not load sessions" :description="listErrorMessage" /></div>
          <div v-else-if="!collapsed && loadingList && invocations.length === 0" class="grid gap-2 px-3"><USkeleton v-for="index in 4" :key="index" class="h-20 rounded-lg" /></div>
          <UEmpty v-else-if="!collapsed && invocations.length === 0" class="px-4" icon="i-lucide-message-square-dashed" title="No sessions yet" description="The first Agent Invocation will appear here." />

          <UScrollArea v-else class="min-h-0 flex-1">
            <nav class="space-y-1 px-2 pb-4" aria-label="Agent sessions">
              <template v-for="invocation in invocations" :key="invocation.id">
                <UTooltip v-if="collapsed" :text="invocationTitle(invocation)" :content="{ side: 'right' }"><UButton :icon="statusIcon(invocation.status)" :color="invocation.status === 'failed' ? 'error' : invocationStale(invocation) ? 'warning' : 'neutral'" :variant="selectedId === invocation.id ? 'soft' : 'ghost'" block :aria-label="invocationTitle(invocation)" @click="selectInvocation(invocation.id)" /></UTooltip>
                <button v-else type="button" class="group flex w-full min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary" :class="selectedId === invocation.id ? 'border-default bg-default shadow-xs' : 'border-transparent hover:bg-elevated/60'" @click="selectInvocation(invocation.id)">
                  <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-elevated"><UIcon :name="invocationStale(invocation) ? 'i-lucide-triangle-alert' : statusIcon(invocation.status)" class="size-3.5" :class="[invocationStale(invocation) ? 'text-warning' : statusColor(invocation.status), invocation.status === 'running' && !invocationStale(invocation) ? 'animate-spin' : undefined]" /></span>
                  <span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-highlighted">{{ invocationTitle(invocation) }}</strong><span class="mt-0.5 block truncate text-xs text-muted">{{ invocationContext(invocation) }}</span><span v-if="invocation.error?.message" class="mt-1 block truncate text-xs text-error">{{ invocationSummary(invocation) }}</span></span>
                  <span class="grid shrink-0 justify-items-end gap-0.5 text-xs"><small :class="invocationStale(invocation) ? 'text-warning' : 'text-muted'">{{ invocationStale(invocation) ? 'No activity' : statusLabel(invocation.status) }}</small><time class="text-dimmed">{{ formatTime(invocationUpdatedAt(invocation)) }}</time></span>
                </button>
              </template>
            </nav>
          </UScrollArea>
          <div v-if="!collapsed && listCursor" class="px-3 pb-2"><UButton block color="neutral" variant="ghost" size="sm" :loading="loadingMore" label="Load older" @click="loadOlder()" /></div>
        </template>

        <template #footer="{ collapsed, collapse }">
          <template v-if="!collapsed"><span class="flex items-center gap-1.5 text-xs text-muted"><UIcon name="i-lucide-lock-keyhole" class="size-3.5" />Read-only</span><span class="ml-auto text-xs" :class="syncStale ? 'text-warning' : 'text-dimmed'">{{ syncLabel }}</span></template>
          <UTooltip text="Refresh sessions"><UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="xs" :loading="loadingList || loadingDetail" aria-label="Refresh sessions" @click="refresh()" /></UTooltip>
          <UButton class="max-lg:hidden" :class="collapsed ? '' : 'ml-1'" :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" color="neutral" variant="ghost" size="xs" :aria-label="collapsed ? 'Show sessions' : 'Hide sessions'" @click="collapse(!collapsed)" />
        </template>
      </UDashboardSidebar>

      <UDashboardPanel id="babysitter-session">
        <div class="min-h-0 flex-1" aria-live="polite">
          <UEmpty v-if="detailErrorMessage" class="h-full" icon="i-lucide-cloud-off" title="Could not load this session" :description="detailErrorMessage" :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: refresh }]" />
          <div v-else-if="loadingDetail && !invocationView" class="flex h-full items-center justify-center"><UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" /></div>
          <template v-else-if="invocationView">
            <USplitter v-if="isDesktop" id="babysitter-session-layout" :items="splitterItems" class="h-full min-h-0">
              <template #thread><AgentInvocation :invocation="invocationView" class="h-full"><template #title="{ invocation }">{{ invocationTitle(invocation) }}</template><template #actions><UTooltip text="Session details"><UButton icon="i-lucide-panel-right" color="neutral" :variant="detailsOpen ? 'soft' : 'ghost'" size="sm" aria-label="Session details" :aria-pressed="detailsOpen" @click="detailsOpen = !detailsOpen" /></UTooltip></template></AgentInvocation></template>
              <template #details><AgentInvocationInspector :invocation="invocationView" class="h-full"><template #actions><UButton icon="i-lucide-panel-right-close" color="neutral" variant="ghost" size="xs" aria-label="Close session details" @click="detailsOpen = false" /></template></AgentInvocationInspector></template>
            </USplitter>
            <AgentInvocation v-else :invocation="invocationView" class="h-full"><template #title="{ invocation }">{{ invocationTitle(invocation) }}</template><template #actions><div class="flex items-center gap-1"><UButton icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" aria-label="Open sessions" @click="sessionsOpen = true" /><UButton icon="i-lucide-panel-right" color="neutral" variant="ghost" size="sm" aria-label="Session details" @click="detailsOpen = true" /></div></template></AgentInvocation>
            <USlideover v-if="!isDesktop" v-model:open="detailsOpen" side="right" title="Session details" :ui="{ content: 'w-full max-w-sm p-0' }"><template #content><AgentInvocationInspector :invocation="invocationView" class="h-full"><template #actions><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="Close session details" @click="detailsOpen = false" /></template></AgentInvocationInspector></template></USlideover>
          </template>
          <div v-else class="flex h-full items-center justify-center text-sm text-muted">Select a session to inspect its work.</div>
        </div>
      </UDashboardPanel>
    </UDashboardGroup>
  </UApp>
</template>
