<script setup lang="ts">
import { useAgentInvocation, useAgentInvocations } from 'vite-hub/agent/vue'
import { computed, ref, watch } from 'vue'
import {
  annotationItems,
  humanize,
  invocationFinishedAt,
  invocationSummary,
  invocationTitle,
  isToolObservation,
  observationContent,
  observationDetail,
  observationDurationMs,
  observationTone,
  statusLabel,
  type Invocation,
} from './invocation-display'

import type { AgentInvocationRecordStatus } from 'vite-hub/agent'

type InvocationGroup = {
  description: string
  label: string
  statuses: AgentInvocationRecordStatus[]
  tone: 'queued' | 'running' | 'finished'
}

const groups: InvocationGroup[] = [
  { description: 'Admitted and waiting for runtime capacity', label: 'Queue', statuses: ['pending'], tone: 'queued' },
  { description: 'Actively producing work', label: 'Running', statuses: ['running'], tone: 'running' },
  { description: 'Terminal invocation history', label: 'Finished', statuses: ['completed', 'failed', 'cancelled'], tone: 'finished' },
]

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

const groupedInvocations = computed(() => groups.map(group => ({
  ...group,
  invocations: invocations.value.filter(invocation => group.statuses.includes(invocation.status)),
})))

const selectedSummary = computed(() => invocations.value.find(invocation => invocation.id === selectedId.value))
const matchingDetail = computed(() => selected.value?.id === selectedId.value ? selected.value : undefined)
const visibleSelection = computed(() => matchingDetail.value || selectedSummary.value)
const visibleObservations = computed(() => matchingDetail.value ? observations.value : [])
const toolObservations = computed(() => visibleObservations.value.filter(isToolObservation))
const visibleAnnotations = computed(() => annotationItems(visibleSelection.value))

async function refresh() {
  await Promise.all([list.refresh(), detail.refresh()])
  refreshedAt.value = new Date()
}

function selectInvocation(id: string) {
  selectedId.value = id
}

function loadOlder() {
  listPolling.value = false
  return list.loadMore()
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : error ? 'Unable to load Agent Invocations.' : undefined
}

function formatTime(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatDateTime(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  }).format(date)
}

function formatDuration(milliseconds?: number) {
  if (milliseconds === undefined) return undefined
  if (milliseconds < 1_000) return `${milliseconds} ms`
  const seconds = Math.round(milliseconds / 1_000)
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function invocationDuration(invocation?: Invocation) {
  if (!invocation?.startedAt) return undefined
  const finishedAt = invocationFinishedAt(invocation)
  const end = finishedAt ? new Date(finishedAt).valueOf() : Date.now()
  const start = new Date(invocation.startedAt).valueOf()
  return Number.isNaN(start) || Number.isNaN(end) ? undefined : formatDuration(end - start)
}

function observationDuration(observation: Parameters<typeof observationDurationMs>[0]) {
  return formatDuration(observationDurationMs(observation))
}

watch(invocations, (next) => {
  if (!selectedId.value || !next.some(invocation => invocation.id === selectedId.value)) {
    selectedId.value = next.find(invocation => invocation.status === 'running')?.id || next[0]?.id
  }
  refreshedAt.value = new Date()
}, { immediate: true })
</script>

<template>
  <UApp>
    <div class="console-shell">
      <header class="console-header">
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <p>ViteHub</p>
            <h1>Console</h1>
          </div>
        </div>

        <div class="header-status">
          <span class="read-only-label"><i aria-hidden="true" /> Read-only</span>
          <span v-if="refreshedAt" class="refresh-time">Updated {{ formatTime(refreshedAt.toISOString()) }}</span>
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :loading="loadingList"
            label="Refresh"
            @click="refresh()"
          />
        </div>
      </header>

      <main class="console-workspace">
        <aside class="invocation-rail" aria-label="Agent invocations">
          <div class="rail-heading">
            <div>
              <p class="eyebrow">Agent activity</p>
              <h2>Invocations</h2>
            </div>
            <span class="total-count">{{ invocations.length }}</span>
          </div>

          <div v-if="listErrorMessage" class="notice" role="alert">
            <strong>Console unavailable</strong>
            <p>{{ listErrorMessage }}</p>
            <UButton color="neutral" variant="soft" size="xs" label="Try again" @click="refresh()" />
          </div>

          <div v-else-if="loadingList && invocations.length === 0" class="rail-loading" aria-label="Loading invocations">
            <USkeleton v-for="index in 5" :key="index" class="h-16 w-full rounded-sm" />
          </div>

          <div v-else-if="invocations.length === 0" class="empty-state">
            <span class="empty-glyph" aria-hidden="true">○</span>
            <strong>No invocations yet</strong>
            <p>The first Agent Invocation will appear here when it is admitted by the runtime.</p>
          </div>

          <div v-else class="invocation-groups">
            <section v-for="group in groupedInvocations" :key="group.tone" class="invocation-group">
              <header class="group-heading">
                <div>
                  <span class="status-dot" :data-tone="group.tone" />
                  <h3>{{ group.label }}</h3>
                </div>
                <span>{{ group.invocations.length }}</span>
              </header>

              <p v-if="group.invocations.length === 0" class="group-empty">Nothing {{ group.label.toLowerCase() }}.</p>
              <button
                v-for="invocation in group.invocations"
                :key="invocation.id"
                type="button"
                class="invocation-row"
                :class="{ selected: selectedId === invocation.id }"
                :aria-pressed="selectedId === invocation.id"
                @click="selectInvocation(invocation.id)"
              >
                <span class="row-copy">
                  <strong>{{ invocationTitle(invocation) }}</strong>
                  <small>{{ invocationSummary(invocation) }}</small>
                </span>
                <span class="row-time">{{ formatTime(invocation.startedAt || invocation.createdAt) }}</span>
              </button>
            </section>
            <div v-if="listCursor" class="load-older">
              <UButton
                block
                color="neutral"
                variant="soft"
                size="sm"
                :loading="loadingMore"
                label="Load older"
                @click="loadOlder()"
              />
            </div>
          </div>
        </aside>

        <section class="invocation-detail" aria-live="polite">
          <div v-if="!visibleSelection && !loadingList" class="detail-placeholder">
            <span aria-hidden="true">↖</span>
            <div>
              <strong>Select an invocation</strong>
              <p>Inspect its lifecycle, context, and tool activity.</p>
            </div>
          </div>

          <template v-else-if="visibleSelection">
            <header class="detail-heading">
              <div class="detail-title">
                <div class="status-line">
                  <span class="status-dot" :data-tone="visibleSelection.status" />
                  <span>{{ statusLabel(visibleSelection.status) }}</span>
                </div>
                <h2>{{ invocationTitle(visibleSelection) }}</h2>
                <p>{{ invocationSummary(visibleSelection) }}</p>
              </div>

              <dl class="detail-facts">
                <div>
                  <dt>Started</dt>
                  <dd>{{ formatDateTime(visibleSelection.startedAt || visibleSelection.createdAt) }}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{{ invocationDuration(visibleSelection) || '—' }}</dd>
                </div>
                <div>
                  <dt>Agent</dt>
                  <dd>{{ visibleSelection.agentName || 'Unknown' }}</dd>
                </div>
              </dl>
            </header>

            <div v-if="visibleAnnotations.length" class="annotation-strip" aria-label="Invocation annotations">
              <component
                :is="annotation.href ? 'a' : 'span'"
                v-for="annotation in visibleAnnotations"
                :key="`${annotation.label}:${annotation.value}`"
                class="annotation"
                :href="annotation.href"
                :target="annotation.href ? '_blank' : undefined"
                :rel="annotation.href ? 'noreferrer' : undefined"
              >
                <small>{{ annotation.label }}</small>
                <strong>{{ annotation.value }}</strong>
                <span v-if="annotation.href" aria-hidden="true">↗</span>
              </component>
            </div>

            <div v-if="detailErrorMessage" class="notice detail-notice" role="alert">
              <strong>History unavailable</strong>
              <p>{{ detailErrorMessage }}</p>
            </div>

            <div class="evidence-grid" :class="{ loading: loadingDetail }">
              <section class="timeline-panel">
                <div class="section-heading">
                  <div>
                    <p class="eyebrow">Complete history</p>
                    <h3>Session</h3>
                  </div>
                  <span>{{ visibleObservations.length }} events</span>
                </div>

                <ol v-if="visibleObservations.length" class="timeline">
                  <li v-for="observation in visibleObservations" :key="observation.sequence" :data-tone="observationTone(observation)">
                    <span class="timeline-node" aria-hidden="true" />
                    <div class="event-copy">
                      <div>
                        <strong>{{ humanize(observation.name) }}</strong>
                        <time :datetime="observation.timestamp">{{ formatTime(observation.timestamp) }}</time>
                      </div>
                      <p v-if="observationDetail(observation)">{{ observationDetail(observation) }}</p>
                      <pre v-if="observationContent(observation)" class="event-content">{{ observationContent(observation) }}</pre>
                    </div>
                  </li>
                </ol>
                <div v-else class="section-empty">
                  <span aria-hidden="true">···</span>
                  <p>No recorded events for this invocation.</p>
                </div>
              </section>

              <aside class="tools-panel">
                <div class="section-heading">
                  <div>
                    <p class="eyebrow">Capability activity</p>
                    <h3>Tools</h3>
                  </div>
                  <span>{{ toolObservations.length }}</span>
                </div>

                <ul v-if="toolObservations.length" class="tool-list">
                  <li v-for="observation in toolObservations" :key="observation.sequence">
                    <span class="tool-index">{{ String(toolObservations.indexOf(observation) + 1).padStart(2, '0') }}</span>
                    <div>
                      <strong>{{ humanize(observation.name) }}</strong>
                      <p>{{ observationDetail(observation) || humanize(observation.type) }}</p>
                    </div>
                    <time v-if="observationDuration(observation)">{{ observationDuration(observation) }}</time>
                  </li>
                </ul>
                <div v-else class="section-empty compact">
                  <span aria-hidden="true">—</span>
                  <p>No tool calls recorded.</p>
                </div>

                <div class="invocation-id">
                  <span>Invocation ID</span>
                  <code>{{ visibleSelection.id }}</code>
                </div>
              </aside>
            </div>
          </template>
        </section>
      </main>
    </div>
  </UApp>
</template>
