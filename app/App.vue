<script setup lang="ts">
import { AgentInvocation, type AgentInvocationView } from '@vite-hub/ui'
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
const invocationView = computed<AgentInvocationView | undefined>(() => matchingDetail.value
  ? { ...matchingDetail.value, observations: observations.value }
  : undefined)

async function refresh() {
  await Promise.all([list.refresh(), selectedId.value ? detail.refresh() : Promise.resolve()])
  refreshedAt.value = new Date()
}

function selectInvocation(id?: string) {
  selectedId.value = id
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
  if (selectedId.value && !next.some(invocation => invocation.id === selectedId.value)) selectedId.value = undefined
  refreshedAt.value = new Date()
}, { immediate: true })
</script>

<template>
  <UApp>
    <div class="babysitter-shell">
      <header class="app-header">
        <button type="button" class="brand-lockup" aria-label="All sessions" @click="selectInvocation()">
          <span class="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>
            <small>ViteHub</small>
            <strong>Babysitter</strong>
          </span>
        </button>

        <div class="header-actions">
          <span class="read-only-label"><i aria-hidden="true" /> Read-only</span>
          <span v-if="refreshedAt" class="refresh-time">Updated {{ formatTime(refreshedAt.toISOString()) }}</span>
          <UTooltip text="Refresh sessions">
            <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" :loading="loadingList || loadingDetail" aria-label="Refresh sessions" @click="refresh()" />
          </UTooltip>
        </div>
      </header>

      <main v-if="!selectedId" class="sessions-index">
        <div class="sessions-index__inner">
          <header class="sessions-heading">
            <div>
              <p><span aria-hidden="true" /> Agent activity</p>
              <h1>Sessions</h1>
              <div>Open a thread to inspect its conversation, work, and result.</div>
            </div>
            <span class="session-count">{{ invocations.length }}</span>
          </header>

          <div v-if="listErrorMessage" class="notice" role="alert">
            <strong>Could not load sessions</strong>
            <p>{{ listErrorMessage }}</p>
            <UButton color="neutral" variant="soft" size="sm" label="Try again" @click="refresh()" />
          </div>

          <div v-else-if="loadingList && invocations.length === 0" class="session-skeletons" aria-label="Loading sessions">
            <USkeleton v-for="index in 5" :key="index" class="h-20 w-full rounded-xl" />
          </div>

          <div v-else-if="invocations.length === 0" class="empty-state">
            <span aria-hidden="true">◇</span>
            <strong>No sessions yet</strong>
            <p>The first Agent Invocation will appear here when it is admitted by the runtime.</p>
          </div>

          <div v-else class="session-list">
            <button v-for="invocation in invocations" :key="invocation.id" type="button" class="session-row" @click="selectInvocation(invocation.id)">
              <span class="session-icon" :data-status="invocation.status">
                <UIcon name="i-lucide-square-terminal" />
                <i v-if="invocation.status === 'running'" aria-hidden="true" />
              </span>
              <span class="session-copy">
                <span>
                  <strong>{{ invocationTitle(invocation) }}</strong>
                  <small :data-status="invocation.status">{{ statusLabel(invocation.status) }}</small>
                </span>
                <span>{{ invocationContext(invocation) }}</span>
                <span v-if="invocation.error?.message" class="session-error">{{ invocationSummary(invocation) }}</span>
              </span>
              <time>{{ formatTime(invocationUpdatedAt(invocation)) }}</time>
              <UIcon name="i-lucide-chevron-right" class="session-chevron" />
            </button>
          </div>

          <div v-if="listCursor" class="load-older">
            <UButton color="neutral" variant="soft" size="sm" :loading="loadingMore" label="Load older sessions" @click="loadOlder()" />
          </div>
        </div>
      </main>

      <main v-else class="session-detail" aria-live="polite">
        <div v-if="detailErrorMessage" class="notice detail-notice" role="alert">
          <strong>Could not load this session</strong>
          <p>{{ detailErrorMessage }}</p>
          <div>
            <UButton color="neutral" variant="ghost" size="sm" label="All sessions" @click="selectInvocation()" />
            <UButton color="neutral" variant="soft" size="sm" label="Try again" @click="refresh()" />
          </div>
        </div>

        <div v-else-if="loadingDetail && !invocationView" class="detail-loading" aria-label="Loading invocation">
          <UIcon name="i-lucide-loader-circle" />
        </div>

        <AgentInvocation v-else-if="invocationView" :invocation="invocationView">
          <template #navigation>
            <UTooltip text="All sessions">
              <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="sm" aria-label="All sessions" @click="selectInvocation()" />
            </UTooltip>
          </template>
          <template #title="{ invocation }">
            {{ invocationTitle(invocation) }}
          </template>
        </AgentInvocation>
      </main>
    </div>
  </UApp>
</template>
