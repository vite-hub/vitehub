<script setup lang="ts">
import { AgentInvocation, type AgentInvocationConfiguration, type AgentInvocationView } from '@vite-hub/ui'
import { useAgentInvocation, useAgentInvocations } from 'vite-hub/agent/vue'
import { computed, ref, watch } from 'vue'
import { invocationContext, invocationSummary, invocationTitle } from './invocation-display'

import type { AgentInvocationRecordStatus, AgentInvocationSummary } from 'vite-hub/agent'

const selectedId = ref<string>()
const refreshedAt = ref<Date>()
const listPolling = ref<false | number>(5_000)

const request = async <T,>(path: string, options: { signal?: AbortSignal }) => {
  const response = await fetch(path, { signal: options.signal })
  if (!response.ok) throw new Error(`Invocation request failed with status ${response.status}.`)
  return await response.json() as T
}

const list = useAgentInvocations({ pollInterval: listPolling, request })
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
  const configuration = persistedConfiguration as AgentInvocationConfiguration | undefined
    ?? observedConfiguration(observations.value)
  return {
    ...matchingDetail.value,
    ...(configuration ? { configuration } : {}),
    observations: observations.value,
  }
})

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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
  refreshedAt.value = new Date()
}

function loadOlder() {
  listPolling.value = false
  return list.loadMore()
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : error ? 'Unable to load Agent Invocations.' : undefined
}

function statusLabel(status: AgentInvocationRecordStatus) {
  return ({ cancelled: 'Cancelled', completed: 'Completed', failed: 'Failed', pending: 'Queued', running: 'Working' } as const)[status]
}

function formatTime(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  const elapsed = Date.now() - date.valueOf()
  if (elapsed < 60_000) return 'now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function invocationUpdatedAt(invocation: AgentInvocationSummary) {
  return invocation.updatedAt || invocation.startedAt || invocation.createdAt
}

watch(invocations, (next) => {
  if (!next.length) selectedId.value = undefined
  else if (!selectedId.value || !next.some(invocation => invocation.id === selectedId.value)) selectedId.value = next[0]!.id
  refreshedAt.value = new Date()
}, { immediate: true })
</script>

<template>
  <UApp>
    <div class="babysitter-shell">
      <aside class="sessions-sidebar" aria-label="Agent sessions">
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>
            <small>ViteHub</small>
            <strong>Babysitter</strong>
          </span>
        </div>

        <div class="sidebar-heading">
          <div>
            <span>Agent activity</span>
            <h1>Sessions</h1>
          </div>
          <span class="session-count">{{ invocations.length }}</span>
        </div>

        <div v-if="listErrorMessage" class="sidebar-notice" role="alert">
          <strong>Could not load sessions</strong>
          <p>{{ listErrorMessage }}</p>
        </div>
        <div v-else-if="loadingList && invocations.length === 0" class="sidebar-notice">Loading sessions…</div>
        <div v-else-if="invocations.length === 0" class="sidebar-notice">The first Agent Invocation will appear here.</div>

        <nav v-else class="session-list">
          <button
            v-for="invocation in invocations"
            :key="invocation.id"
            type="button"
            class="session-row"
            :class="{ 'is-selected': selectedId === invocation.id }"
            @click="selectedId = invocation.id"
          >
            <span class="session-status" :data-status="invocation.status" aria-hidden="true" />
            <span class="session-copy">
              <strong>{{ invocationTitle(invocation) }}</strong>
              <span>{{ invocationContext(invocation) }}</span>
              <span v-if="invocation.error?.message" class="session-error">{{ invocationSummary(invocation) }}</span>
            </span>
            <span class="session-meta">
              <small>{{ statusLabel(invocation.status) }}</small>
              <time>{{ formatTime(invocationUpdatedAt(invocation)) }}</time>
            </span>
          </button>
        </nav>

        <div v-if="listCursor" class="load-older">
          <UButton color="neutral" variant="ghost" size="sm" :loading="loadingMore" label="Load older" @click="loadOlder()" />
        </div>

        <footer class="sidebar-footer">
          <span class="read-only-label"><i aria-hidden="true" /> Read-only</span>
          <span v-if="refreshedAt">Updated {{ formatTime(refreshedAt.toISOString()) }}</span>
          <UTooltip text="Refresh sessions">
            <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="xs" :loading="loadingList || loadingDetail" aria-label="Refresh sessions" @click="refresh()" />
          </UTooltip>
        </footer>
      </aside>

      <main class="session-workspace" aria-live="polite">
        <div v-if="detailErrorMessage" class="workspace-notice" role="alert">
          <strong>Could not load this session</strong>
          <p>{{ detailErrorMessage }}</p>
          <UButton color="neutral" variant="soft" size="sm" label="Try again" @click="refresh()" />
        </div>
        <div v-else-if="loadingDetail && !invocationView" class="workspace-loading" aria-label="Loading invocation">
          <UIcon name="i-lucide-loader-circle" />
        </div>
        <AgentInvocation v-else-if="invocationView" :invocation="invocationView">
          <template #title="{ invocation }">{{ invocationTitle(invocation) }}</template>
        </AgentInvocation>
        <div v-else class="workspace-empty">Select a session to inspect its work.</div>
      </main>
    </div>
  </UApp>
</template>
