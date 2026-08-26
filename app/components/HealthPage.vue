<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

type Diagnostic = { detail?: string, label: string, status: 'neutral' | 'ok' | 'warning', value: string }
type Health = {
  checkedAt: string
  diagnostics: Diagnostic[]
  status: 'degraded' | 'healthy'
  summary: string
  workload: { active: number, completed: number, failed: number, snapshots: number, total: number }
}

const health = ref<Health>()
const error = ref<string>()
const loading = ref(true)
const refreshing = ref(false)
let poll: ReturnType<typeof setInterval> | undefined

const checkedLabel = computed(() => health.value
  ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(health.value.checkedAt))
  : undefined)
const readyCount = computed(() => health.value?.diagnostics.filter(item => item.status === 'ok').length ?? 0)
const totals = computed(() => health.value ? [
  { label: 'Invocations', value: health.value.workload.total },
  { label: 'Active', value: health.value.workload.active },
  { label: 'Completed', value: health.value.workload.completed },
  { label: 'Failed', value: health.value.workload.failed },
  { label: 'Snapshots', value: health.value.workload.snapshots },
] : [])
const outcomes = computed(() => health.value ? [
  { label: 'Completed', status: 'completed', value: health.value.workload.completed },
  { label: 'Active', status: 'active', value: health.value.workload.active },
  { label: 'Failed', status: 'failed', value: health.value.workload.failed },
].map(item => ({
  ...item,
  percent: health.value!.workload.total ? Math.round(item.value / health.value!.workload.total * 100) : 0,
})) : [])
const primaryDiagnostics = computed(() => health.value?.diagnostics.filter(item => ['GitHub', 'Codex', 'Scheduler'].includes(item.label)) ?? [])

function readinessLabel(status: Diagnostic['status']) {
  if (status === 'ok') return 'Ready'
  if (status === 'warning') return 'Attention'
  return 'Optional'
}

async function load() {
  refreshing.value = true
  try {
    const response = await fetch('/api/health')
    if (!response.ok) throw new Error(`Health request failed with status ${response.status}.`)
    health.value = await response.json() as Health
    error.value = undefined
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Health data is unavailable.'
  }
  finally {
    loading.value = false
    refreshing.value = false
  }
}

onMounted(() => {
  void load()
  poll = setInterval(() => void load(), 30_000)
})

onBeforeUnmount(() => {
  if (poll) clearInterval(poll)
})
</script>

<template>
  <main class="health-page">
    <header class="health-page__header">
      <div class="health-page__breadcrumb">
        <h1>Health</h1>
        <span v-if="checkedLabel" aria-hidden="true">/</span>
        <p v-if="checkedLabel">Checked {{ checkedLabel }}</p>
      </div>
      <div class="health-page__header-actions">
        <button type="button" aria-label="Refresh health" :disabled="refreshing" @click="load">
          <UIcon name="i-lucide-refresh-cw" :class="{ 'animate-spin': refreshing }" />
        </button>
      </div>
    </header>

    <div class="health-page__scroll">
      <div class="health-page__content">
        <div v-if="loading && !health" class="health-skeleton" aria-label="Checking Babysitter health">
          <section><i /><small /><span v-for="index in 3" :key="index" /></section>
          <section><small /><span /></section>
        </div>

        <div v-else-if="error && !health" class="health-notice" data-status="error">
          <div><strong>Health check unavailable</strong><span>{{ error }}</span></div>
          <button type="button" @click="load">Try again</button>
        </div>

        <template v-else-if="health">
          <div v-if="health.status === 'degraded' || error" class="health-notice" :data-status="health.status === 'degraded' ? 'warning' : 'stale'">
            <UIcon :name="health.status === 'degraded' ? 'i-lucide-triangle-alert' : 'i-lucide-wifi-off'" />
            <div>
              <strong>{{ health.status === 'degraded' ? 'One or more dependencies need attention' : 'Showing the last successful check' }}</strong>
              <span>{{ error || 'The diagnostics below identify the unavailable dependency.' }}</span>
            </div>
          </div>

          <section class="health-overview">
            <div class="health-overview__summary">
              <div>
                <strong>{{ health.status === 'healthy' ? 'Operational' : 'Degraded' }}</strong>
                <span>{{ readyCount }} of {{ health.diagnostics.length }} checks ready · live service</span>
              </div>

              <dl class="health-services">
                <div v-for="item in primaryDiagnostics" :key="item.label" :data-status="item.status">
                  <dt><i />{{ item.label }}<small v-if="item.detail">{{ item.detail }}</small></dt>
                  <dd>{{ item.value }}</dd>
                </div>
              </dl>
            </div>

            <div class="health-outcomes">
              <h2>Recent invocation outcomes</h2>
              <div class="health-outcomes__plot">
                <div v-for="item in outcomes" :key="item.label" :data-status="item.status">
                  <div><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.percent }}%</small></div>
                  <span role="progressbar" :aria-label="`${item.label} invocations`" :aria-valuenow="item.value" :aria-valuemax="health.workload.total"><i :style="{ width: `${item.percent}%` }" /></span>
                </div>
              </div>
            </div>
          </section>

          <section class="health-totals">
            <h2>Totals</h2>
            <dl>
              <div v-for="metric in totals" :key="metric.label"><dt>{{ metric.label }}</dt><dd>{{ metric.value }}</dd></div>
            </dl>
          </section>

          <section class="health-breakdown">
            <header><h2>Diagnostics</h2><span>Live service configuration and readiness</span></header>
            <div class="health-breakdown__table" role="table" aria-label="Babysitter diagnostics">
              <div class="health-breakdown__head" role="row"><span role="columnheader">Component</span><span role="columnheader">Readiness</span><span role="columnheader">Value</span><span role="columnheader">Detail</span></div>
              <div v-for="item in health.diagnostics" :key="item.label" role="row" :data-status="item.status">
                <span role="cell"><i />{{ item.label }}</span>
                <strong role="cell">{{ readinessLabel(item.status) }}</strong>
                <span role="cell">{{ item.value }}</span>
                <small role="cell">{{ item.detail || '—' }}</small>
              </div>
            </div>
          </section>
        </template>
      </div>
    </div>
  </main>
</template>
