<script setup lang="ts">
import type { AgentInvocationView } from '@vite-hub/ui'
import { computed, ref, watch } from 'vue'

type Observation = AgentInvocationView['observations'][number]
type SpanStatus = 'completed' | 'failed' | 'recovered' | 'running'

type TraceSpan = {
  activityId: string
  attributes: Record<string, unknown>
  depth: number
  description?: string
  durationMs: number
  endMs: number
  eventNames: string[]
  icon: string
  id: string
  name: string
  operation: string
  sequence: number
  startMs: number
  status: SpanStatus
}

const props = defineProps<{ invocation: AgentInvocationView }>()
const emit = defineEmits<{ focusActivity: [activityId: string] }>()
const spanQuery = ref('')
const fieldQuery = ref('')
const selectedSpanId = ref<string>()
const copied = ref(false)

const spans = computed(() => buildSpans(props.invocation))
const traceStartMs = computed(() => spans.value[0]?.startMs ?? timestamp(props.invocation.startedAt || props.invocation.createdAt))
const traceEndMs = computed(() => Math.max(
  timestamp(props.invocation.completedAt || props.invocation.failedAt || props.invocation.updatedAt),
  ...spans.value.map(span => span.endMs),
))
const traceDurationMs = computed(() => Math.max(1, traceEndMs.value - traceStartMs.value))
const filteredSpans = computed(() => {
  const query = spanQuery.value.trim().toLowerCase()
  if (!query) return spans.value
  return spans.value.filter(span => spanSearchText(span).includes(query))
})
const selectedSpan = computed(() => spans.value.find(span => span.id === selectedSpanId.value) ?? spans.value[0])
const selectedAttributes = computed(() => selectedSpan.value ? {
  'span.id': selectedSpan.value.id,
  'trace.id': props.invocation.traceId,
  'span.operation': selectedSpan.value.operation,
  'span.status': selectedSpan.value.status,
  'span.start_time': new Date(selectedSpan.value.startMs).toISOString(),
  'span.end_time': new Date(selectedSpan.value.endMs).toISOString(),
  'span.duration_ms': selectedSpan.value.durationMs,
  'span.events': selectedSpan.value.eventNames,
  ...selectedSpan.value.attributes,
} : {})
const filteredAttributes = computed(() => {
  const query = fieldQuery.value.trim().toLowerCase()
  return Object.entries(selectedAttributes.value).filter(([key, value]) => !query || `${key} ${searchable(value)}`.toLowerCase().includes(query))
})
const ticks = computed(() => [0, .25, .5, .75, 1].map(position => ({
  label: formatAxis(traceDurationMs.value * position),
  position,
})))

watch(spans, (value) => {
  if (!value.some(span => span.id === selectedSpanId.value)) selectedSpanId.value = value[0]?.id
}, { immediate: true })

watch(selectedSpanId, () => {
  fieldQuery.value = ''
  copied.value = false
})

function buildSpans(invocation: AgentInvocationView): TraceSpan[] {
  const observations = [...invocation.observations].sort((left, right) => left.sequence - right.sequence)
  const starts = observations.filter(observation => observation.name.endsWith('.start'))
  const result = starts.map((start) => pairedSpan(start, observations, invocation))
  const representedSequences = new Set(result.flatMap(span => span.eventNames.map(name => `${span.id}:${name}`)))

  for (const observation of observations) {
    if (!observation.name.endsWith('.error')) continue
    const id = eventId(observation)
    if (representedSequences.has(`${id}:${observation.name}`)) continue
    const at = timestamp(observation.timestamp)
    const recovered = observation.attributes?.['error.recoverable'] === true && invocation.status === 'completed'
    result.push({
      activityId: id,
      attributes: { ...observation.attributes },
      depth: 1,
      durationMs: 0,
      endMs: at,
      eventNames: [observation.name],
      icon: recovered ? 'i-lucide-circle-check' : 'i-lucide-circle-alert',
      id: `${id}:error:${observation.sequence}`,
      name: recovered && observation.name === 'agent.stream.error' ? 'Stream recovered' : humanize(observation.name),
      operation: recovered ? 'recovery' : 'error',
      sequence: observation.sequence,
      startMs: at,
      status: recovered ? 'recovered' : 'failed',
    })
  }

  if (!result.some(span => span.operation === 'invoke_agent')) result.unshift(invocationSpan(invocation, observations))
  return result.sort((left, right) => left.depth - right.depth || left.startMs - right.startMs || left.sequence - right.sequence)
}

function pairedSpan(start: Observation, observations: Observation[], invocation: AgentInvocationView): TraceSpan {
  const id = eventId(start)
  const finishName = start.name.replace(/\.start$/, '.finish')
  const finish = observations.find(observation => observation.sequence > start.sequence && observation.name === finishName && eventId(observation) === id)
  const attributes = { ...start.attributes, ...finish?.attributes }
  const startMs = timestamp(start.timestamp)
  const endMs = finish ? timestamp(finish.timestamp) : timestamp(invocation.updatedAt)
  const operation = operationName(start, attributes)
  const target = operationTarget(operation, attributes, invocation)
  const status = spanStatus(finish, attributes, invocation, operation)
  return {
    activityId: id,
    attributes,
    depth: operation === 'invoke_agent' ? 0 : 1,
    description: spanDescription(attributes),
    durationMs: Math.max(0, numeric(attributes['invocation.durationMs']) ?? endMs - startMs),
    endMs,
    eventNames: [start.name, ...(finish ? [finish.name] : [])],
    icon: spanIcon(operation),
    id,
    name: target ? `${operation} ${target}` : operation,
    operation,
    sequence: start.sequence,
    startMs,
    status,
  }
}

function invocationSpan(invocation: AgentInvocationView, observations: Observation[]): TraceSpan {
  const start = observations.find(observation => observation.name === 'agent.invocation.start')
  const finish = observations.find(observation => observation.name === 'agent.invocation.finish')
  const startMs = timestamp(start?.timestamp || invocation.startedAt || invocation.createdAt)
  const endMs = timestamp(finish?.timestamp || invocation.completedAt || invocation.failedAt || invocation.updatedAt)
  return {
    activityId: start ? eventId(start) : invocation.id,
    attributes: { ...start?.attributes, ...finish?.attributes },
    depth: 0,
    durationMs: Math.max(0, numeric(finish?.attributes?.['invocation.durationMs']) ?? endMs - startMs),
    endMs,
    eventNames: [start?.name, finish?.name].filter((value): value is string => Boolean(value)),
    icon: 'i-lucide-bot',
    id: stringAttribute(start, 'agent.invocation.id') || invocation.id,
    name: `invoke_agent ${invocation.agentName || 'agent'}`,
    operation: 'invoke_agent',
    sequence: start?.sequence ?? 0,
    startMs,
    status: invocation.status === 'failed' ? 'failed' : invocation.status === 'running' || invocation.status === 'pending' ? 'running' : 'completed',
  }
}

function eventId(observation: Observation) {
  return stringAttribute(observation, 'step.id')
    || stringAttribute(observation, 'tool.id')
    || stringAttribute(observation, 'gen_ai.tool.call.id')
    || stringAttribute(observation, 'agent.invocation.id')
    || `${observation.name}:${observation.sequence}`
}

function operationName(observation: Observation, attributes: Record<string, unknown>) {
  const explicit = attributes['gen_ai.operation.name']
  if (typeof explicit === 'string' && explicit) return explicit
  if (observation.name.startsWith('agent.invocation.')) return 'invoke_agent'
  if (observation.name.startsWith('agent.tool.')) return 'execute_tool'
  return observation.name.replace(/\.(start|finish)$/, '')
}

function operationTarget(operation: string, attributes: Record<string, unknown>, invocation: AgentInvocationView) {
  if (operation === 'invoke_agent') return invocation.agentName || 'agent'
  const keys = operation === 'execute_tool'
    ? ['gen_ai.tool.name', 'tool.name']
    : ['gen_ai.request.model', 'model.id', 'agent.name']
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value) return value
  }
}

function spanStatus(finish: Observation | undefined, attributes: Record<string, unknown>, invocation: AgentInvocationView, operation: string): SpanStatus {
  if (operation === 'invoke_agent') return invocation.status === 'failed' ? 'failed' : finish ? 'completed' : 'running'
  if (!finish) return 'running'
  const output = record(record(attributes['tool.output'])?.item)
  const exitCode = numeric(output?.exitCode)
  return exitCode !== undefined && exitCode !== 0 || typeof attributes['error.message'] === 'string' ? 'failed' : 'completed'
}

function spanDescription(attributes: Record<string, unknown>) {
  const item = record(record(attributes['tool.input'])?.item)
  const command = item?.command
  if (typeof command === 'string') return compact(command, 90)
  const path = attributes['tool.path']
  return typeof path === 'string' ? path : undefined
}

function spanIcon(operation: string) {
  if (operation === 'invoke_agent') return 'i-lucide-bot'
  if (operation === 'chat') return 'i-lucide-message-square-more'
  if (operation === 'execute_tool') return 'i-lucide-wrench'
  if (operation === 'tool_approval') return 'i-lucide-shield-check'
  return 'i-lucide-layers-3'
}

function barStyle(span: TraceSpan) {
  const left = Math.max(0, Math.min(100, (span.startMs - traceStartMs.value) / traceDurationMs.value * 100))
  const width = Math.max(0, Math.min(100 - left, span.durationMs / traceDurationMs.value * 100))
  return { left: `${left}%`, width: `max(3px, ${width}%)` }
}

function spanSearchText(span: TraceSpan) {
  return `${span.name} ${span.description || ''} ${span.eventNames.join(' ')} ${searchable(span.attributes)}`.toLowerCase()
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringAttribute(observation: Observation | undefined, key: string) {
  const value = observation?.attributes?.[key]
  return typeof value === 'string' ? value : undefined
}

function numeric(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timestamp(value: Date | string | undefined) {
  const result = value instanceof Date ? value.valueOf() : Date.parse(value || '')
  return Number.isFinite(result) ? result : Date.now()
}

function formatDuration(durationMs: number) {
  if (durationMs < 1) return '<1ms'
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${trim(durationMs / 1_000, durationMs < 10_000 ? 2 : 1)}s`
  return formatMinutes(durationMs)
}

function formatAxis(durationMs: number) {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${trim(durationMs / 1_000, 1)}s`
  return formatMinutes(durationMs)
}

function formatMinutes(durationMs: number) {
  const totalSeconds = Math.round(durationMs / 1_000)
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}

function trim(value: number, digits: number) {
  return value.toFixed(digits).replace(/\.?0+$/, '')
}

function shortId(value: string) {
  return value.replace(/^sha256_/, '').slice(0, 16)
}

function humanize(value: string) {
  return value.replaceAll('.', ' ').replaceAll('_', ' ')
}

function compact(value: string, limit: number) {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`
}

function searchable(value: unknown) {
  try { return JSON.stringify(value) }
  catch { return String(value) }
}

function displayValue(value: unknown) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

async function copyAttributes() {
  const value = JSON.stringify(selectedAttributes.value, null, 2)
  try {
    await navigator.clipboard.writeText(value)
  }
  catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1_500)
}
</script>

<template>
  <section class="session-trace">
    <div class="session-trace__waterfall">
      <div class="session-trace__search">
        <UInput v-model="spanQuery" icon="i-lucide-search" placeholder="Search spans" size="sm" variant="outline" :ui="{ base: 'w-full' }" />
        <span>{{ filteredSpans.length }} spans</span>
      </div>

      <div class="session-trace__table-scroll">
        <div class="session-trace__table">
          <div class="session-trace__table-head">
            <strong>Name</strong>
            <div class="session-trace__axis">
              <span v-for="tick in ticks" :key="tick.position" :style="{ left: `${tick.position * 100}%` }">{{ tick.label }}</span>
            </div>
          </div>
          <div class="session-trace__rows">
            <button
              v-for="span in filteredSpans"
              :key="span.id"
              type="button"
              class="session-trace__row"
              :data-selected="selectedSpan?.id === span.id"
              :data-status="span.status"
              @click="selectedSpanId = span.id; emit('focusActivity', span.activityId)"
            >
              <span class="session-trace__name" :style="{ paddingInlineStart: `${.75 + span.depth * 1.65}rem` }">
                <UIcon :name="span.icon" />
                <span><strong>{{ span.name }}</strong><small v-if="span.description">{{ span.description }}</small></span>
              </span>
              <span class="session-trace__timeline">
                <i v-for="tick in ticks" :key="tick.position" :style="{ left: `${tick.position * 100}%` }" />
                <span class="session-trace__bar" :data-wide="span.durationMs / traceDurationMs > .16" :style="barStyle(span)"><span>{{ formatDuration(span.durationMs) }}</span></span>
              </span>
            </button>
            <div v-if="filteredSpans.length === 0" class="session-trace__empty">No spans match this search.</div>
          </div>
        </div>
      </div>
    </div>

    <aside v-if="selectedSpan" class="session-trace__detail">
      <header class="session-trace__detail-head">
        <strong><i :data-status="selectedSpan.status" />Span {{ shortId(selectedSpan.id) }}</strong>
        <button type="button" @click="copyAttributes"><UIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" />{{ copied ? 'Copied' : 'Copy attributes' }}</button>
      </header>
      <section class="session-trace__summary">
        <span>{{ selectedSpan.operation.replaceAll('_', ' ') }} · {{ selectedSpan.status }}</span>
        <h3><UIcon :name="selectedSpan.icon" />{{ selectedSpan.name }}</h3>
        <dl>
          <div><dt>Duration</dt><dd>{{ formatDuration(selectedSpan.durationMs) }}</dd></div>
          <div><dt>Trace ID</dt><dd><code>{{ shortId(invocation.traceId) }}</code></dd></div>
          <div><dt>Span ID</dt><dd><code>{{ shortId(selectedSpan.id) }}</code></dd></div>
        </dl>
      </section>
      <div class="session-trace__field-search"><UInput v-model="fieldQuery" icon="i-lucide-search" placeholder="Search fields…" size="sm" variant="outline" /></div>
      <div class="session-trace__fields">
        <section v-for="([key, value]) in filteredAttributes" :key="key">
          <span>{{ key }}</span>
          <pre>{{ displayValue(value) }}</pre>
        </section>
        <div v-if="filteredAttributes.length === 0" class="session-trace__empty">No fields match this search.</div>
      </div>
    </aside>
  </section>
</template>
