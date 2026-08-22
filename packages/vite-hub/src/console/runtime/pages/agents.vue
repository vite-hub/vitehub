<script setup lang="ts">
import { AgentInvocation } from "@vite-hub/ui"
import { useAgentInvocation, useAgentInvocations } from "vite-hub/agent/vue"
import { computed, ref, watch } from "vue"

import type { AgentInvocationSummary } from "vite-hub/agent"
import type { AgentInvocationConfiguration, AgentInvocationView } from "@vite-hub/ui"

type ConsoleSession = {
  agentName?: string
  id: string
  invocations: AgentInvocationSummary[]
  updatedAt: string
}

const route = useRoute()
const router = useRouter()
const selectedInvocationId = ref<string>()
const refreshedAt = ref<Date>()
const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "")
const apiBase = `${appBaseURL}/api/_vitehub/console/invocations`

useHead({ title: "Agents · ViteHub Console" })

const request = async <T,>(path: string, options: { signal?: AbortSignal }) => {
  const response = await fetch(path, { signal: options.signal })
  if (!response.ok) throw new Error(`Console request failed with status ${response.status}.`)
  return await response.json() as T
}

const list = useAgentInvocations({ baseURL: apiBase, pollInterval: 5_000, request })
const detail = useAgentInvocation(selectedInvocationId, { baseURL: apiBase, pollInterval: 3_000, request })

const sessions = computed<ConsoleSession[]>(() => {
  const grouped = new Map<string, ConsoleSession>()
  for (const invocation of list.invocations.value) {
    const id = invocation.threadId || invocation.id
    const session = grouped.get(id)
    if (session) session.invocations.push(invocation)
    else grouped.set(id, {
      agentName: invocation.agentName,
      id,
      invocations: [invocation],
      updatedAt: invocation.updatedAt,
    })
  }
  return [...grouped.values()]
})

const routeSession = computed(() => {
  const value = route.params.session
  return Array.isArray(value) ? value[0] : value
})
const selectedSession = computed(() => sessions.value.find(session => session.id === routeSession.value))
const invocationView = computed<AgentInvocationView | undefined>(() => {
  const invocation = detail.invocation.value
  if (!invocation) return
  const persistedConfiguration = record(record(invocation)?.configuration)
  const configuration = persistedConfiguration as AgentInvocationConfiguration | undefined
    ?? observedConfiguration(detail.observations.value)
  return {
    ...invocation,
    ...(configuration ? { configuration } : {}),
    observations: detail.observations.value,
  }
})

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function observedConfiguration(entries: AgentInvocationView["observations"]): AgentInvocationConfiguration | undefined {
  for (const entry of entries) {
    if (entry.name !== "vitehub.agent.configured") continue
    const configuration = record(entry.attributes?.["vitehub.agent.configuration"])
    if (configuration) return configuration as AgentInvocationConfiguration
  }
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : error ? "The console could not load this data." : undefined
}

function relativeTime(value?: string): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  const elapsed = Date.now() - date.valueOf()
  if (elapsed < 60_000) return "now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date)
}

function runLabel(invocation: AgentInvocationSummary): string {
  const date = new Date(invocation.createdAt)
  return Number.isNaN(date.valueOf())
    ? invocation.createdAt
    : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date)
}

async function selectSession(session: ConsoleSession): Promise<void> {
  await router.push({ name: "vitehub-console-agents", params: { session: session.id } })
}

async function refresh(): Promise<void> {
  await Promise.all([list.refresh(), selectedInvocationId.value ? detail.refresh() : Promise.resolve()])
  refreshedAt.value = new Date()
}

watch(sessions, async (next) => {
  if (next.length && !next.some(session => session.id === routeSession.value)) await selectSession(next[0]!)
  refreshedAt.value = new Date()
}, { immediate: true })

watch(selectedSession, (session) => {
  selectedInvocationId.value = session?.invocations.some(invocation => invocation.id === selectedInvocationId.value)
    ? selectedInvocationId.value
    : session?.invocations[0]?.id
}, { immediate: true })
</script>

<template>
  <div class="vh-console">
    <aside class="vh-console__sidebar" aria-label="Agent sessions">
      <NuxtLink class="vh-console__brand" to="/_vitehub/agents">
        <span class="vh-console__mark" aria-hidden="true"><i /><i /><i /></span>
        <span><small>ViteHub</small><strong>Console</strong></span>
      </NuxtLink>

      <div class="vh-console__heading">
        <div><span>Agent activity</span><h1>Sessions</h1></div>
        <span>{{ sessions.length }}</span>
      </div>

      <div v-if="errorMessage(list.error.value)" class="vh-console__notice" role="alert">
        <strong>Could not load sessions</strong>
        <p>{{ errorMessage(list.error.value) }}</p>
      </div>
      <div v-else-if="list.isLoading.value && !sessions.length" class="vh-console__notice">Loading sessions…</div>
      <div v-else-if="!sessions.length" class="vh-console__notice">The first Agent Invocation will appear here.</div>

      <nav v-else class="vh-console__sessions">
        <div v-for="session in sessions" :key="session.id" class="vh-console__session-group">
          <button
            class="vh-console__session"
            :class="{ 'is-selected': selectedSession?.id === session.id }"
            type="button"
            @click="selectSession(session)"
          >
            <span class="vh-console__status" :data-status="session.invocations[0]?.status" aria-hidden="true" />
            <span class="vh-console__session-copy">
              <strong>{{ session.agentName || "Agent session" }}</strong>
              <span>{{ session.invocations.length }} run{{ session.invocations.length === 1 ? "" : "s" }}</span>
            </span>
            <time>{{ relativeTime(session.updatedAt) }}</time>
          </button>

          <div v-if="selectedSession?.id === session.id" class="vh-console__runs" aria-label="Session invocations">
            <button
              v-for="invocation in session.invocations"
              :key="invocation.id"
              :aria-pressed="selectedInvocationId === invocation.id"
              type="button"
              @click="selectedInvocationId = invocation.id"
            >
              <span class="vh-console__status" :data-status="invocation.status" aria-hidden="true" />
              <span>Run {{ runLabel(invocation) }}</span>
              <small>{{ invocation.status }}</small>
            </button>
          </div>
        </div>
      </nav>

      <div v-if="list.cursor.value" class="vh-console__older">
        <UButton
          block
          color="neutral"
          label="Load older"
          size="sm"
          variant="ghost"
          :loading="list.isLoadingMore.value"
          @click="list.loadMore"
        />
      </div>

      <footer class="vh-console__footer">
        <span class="vh-console__read-only"><i aria-hidden="true" /> Read-only</span>
        <span v-if="refreshedAt">Updated {{ relativeTime(refreshedAt.toISOString()) }}</span>
        <UTooltip text="Refresh sessions">
          <UButton
            aria-label="Refresh sessions"
            color="neutral"
            icon="i-lucide-refresh-cw"
            size="xs"
            variant="ghost"
            :loading="list.isLoading.value || detail.isLoading.value"
            @click="refresh"
          />
        </UTooltip>
      </footer>
    </aside>

    <main class="vh-console__workspace" aria-live="polite">
      <div v-if="!selectedSession" class="vh-console__empty">Select a session to inspect its work.</div>
      <div v-else-if="errorMessage(detail.error.value)" class="vh-console__workspace-notice" role="alert">
        <strong>Could not load this run</strong>
        <p>{{ errorMessage(detail.error.value) }}</p>
        <UButton color="neutral" label="Try again" size="sm" variant="soft" @click="refresh" />
      </div>
      <div v-else-if="detail.isLoading.value && !invocationView" class="vh-console__loading" aria-label="Loading invocation">
        <UIcon name="i-lucide-loader-circle" />
      </div>
      <AgentInvocation v-else-if="invocationView" :invocation="invocationView">
        <template #title>{{ selectedSession.agentName || "Agent session" }}</template>
      </AgentInvocation>
    </main>
  </div>
</template>

<style scoped>
.vh-console {
  background: var(--ui-bg, Canvas);
  color: var(--ui-text, CanvasText);
  display: grid;
  grid-template-columns: minmax(17rem, 21rem) minmax(0, 1fr);
  height: 100dvh;
  min-height: 32rem;
  overflow: hidden;
}

.vh-console__sidebar {
  background: var(--ui-bg-muted, #f7f8fa);
  border-inline-end: 1px solid var(--ui-border, #e4e4e7);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.vh-console__brand {
  align-items: center;
  border-block-end: 1px solid var(--ui-border, #e4e4e7);
  color: inherit;
  display: flex;
  flex: none;
  gap: .65rem;
  min-height: 3.75rem;
  padding: .65rem .85rem;
  text-decoration: none;
}

.vh-console__brand > span:last-child { display: grid; }
.vh-console__brand small {
  color: var(--ui-text-muted, #71717a);
  font-size: .6rem;
  font-weight: 700;
  letter-spacing: .12em;
  line-height: 1;
  text-transform: uppercase;
}
.vh-console__brand strong { font-size: .8125rem; font-weight: 600; line-height: 1; margin-block-start: .2rem; }

.vh-console__mark {
  align-items: end;
  background: var(--ui-text, #18181b);
  border-radius: .35rem;
  display: grid;
  gap: .17rem;
  grid-template-columns: repeat(3, 1fr);
  height: 1.75rem;
  padding: .3rem;
  width: 1.75rem;
}
.vh-console__mark i { background: var(--ui-bg, #fff); display: block; height: 55%; }
.vh-console__mark i:nth-child(2) { background: var(--ui-primary, #7c3aed); height: 100%; }
.vh-console__mark i:nth-child(3) { height: 74%; }

.vh-console__heading {
  align-items: flex-end;
  display: flex;
  flex: none;
  justify-content: space-between;
  padding: 1.1rem 1rem .75rem;
}
.vh-console__heading div > span {
  color: var(--ui-text-muted, #71717a);
  font-size: .625rem;
  font-weight: 650;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.vh-console__heading h1 { font-size: 1rem; font-weight: 650; margin: .25rem 0 0; }
.vh-console__heading > span { color: var(--ui-text-dimmed, #a1a1aa); font-size: .6875rem; }

.vh-console__sessions {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  padding: 0 .65rem 1rem;
}
.vh-console__session-group { margin-block-end: .2rem; }
.vh-console__session,
.vh-console__runs button {
  appearance: none;
  background: transparent;
  border: 1px solid transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: start;
  width: 100%;
}
.vh-console__session {
  border-radius: .55rem;
  display: grid;
  gap: .65rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
  padding: .7rem .75rem;
}
.vh-console__session.is-selected { background: var(--ui-bg, #fff); border-color: var(--ui-border, #e4e4e7); }
.vh-console__session:active,
.vh-console__runs button:active { transform: scale(.985); }
.vh-console__session-copy { display: grid; gap: .15rem; min-width: 0; }
.vh-console__session-copy strong,
.vh-console__session-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vh-console__session-copy strong { font-size: .75rem; font-weight: 600; }
.vh-console__session-copy span,
.vh-console__session time { color: var(--ui-text-dimmed, #a1a1aa); font-size: .625rem; }

.vh-console__status {
  background: var(--ui-text-dimmed, #a1a1aa);
  border-radius: 999px;
  height: .45rem;
  margin-block-start: .35rem;
  width: .45rem;
}
.vh-console__status[data-status="running"] { background: var(--ui-info, #0284c7); }
.vh-console__status[data-status="completed"] { background: var(--ui-success, #16a34a); }
.vh-console__status[data-status="failed"] { background: var(--ui-error, #dc2626); }

.vh-console__runs { display: grid; gap: .1rem; padding: .2rem .35rem .45rem 1.45rem; }
.vh-console__runs button {
  align-items: center;
  border-radius: .45rem;
  display: grid;
  font-size: .6875rem;
  gap: .5rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
  padding: .45rem .55rem;
}
.vh-console__runs button[aria-pressed="true"] { background: var(--ui-bg-elevated, #f4f4f5); }
.vh-console__runs small { color: var(--ui-text-dimmed, #a1a1aa); font-size: .6rem; text-transform: capitalize; }

.vh-console__notice,
.vh-console__workspace-notice { color: var(--ui-text-muted, #71717a); font-size: .75rem; padding: 1rem; }
.vh-console__notice strong,
.vh-console__workspace-notice strong { color: var(--ui-error, #dc2626); }
.vh-console__notice p,
.vh-console__workspace-notice p { margin: .35rem 0 .75rem; }
.vh-console__older { padding: .25rem .75rem; }

.vh-console__footer {
  align-items: center;
  border-block-start: 1px solid var(--ui-border, #e4e4e7);
  color: var(--ui-text-dimmed, #a1a1aa);
  display: grid;
  flex: none;
  font-size: .625rem;
  gap: .5rem;
  grid-template-columns: auto 1fr auto;
  min-height: 3rem;
  padding: .5rem .75rem;
}
.vh-console__read-only { align-items: center; color: var(--ui-text-muted, #71717a); display: flex; gap: .35rem; }
.vh-console__read-only i { background: var(--ui-success, #16a34a); border-radius: 999px; height: .4rem; width: .4rem; }

.vh-console__workspace { min-height: 0; min-width: 0; overflow: hidden; }
.vh-console__workspace > :deep(.vh-invocation-session) { height: 100%; }
.vh-console__empty,
.vh-console__loading {
  align-items: center;
  color: var(--ui-text-muted, #71717a);
  display: flex;
  height: 100%;
  justify-content: center;
  padding: 2rem;
}
.vh-console__loading svg { animation: vh-console-spin 1s linear infinite; }

@media (hover: hover) {
  .vh-console__session:hover,
  .vh-console__runs button:hover { background: var(--ui-bg-elevated, #f4f4f5); }
}

@media (max-width: 760px) {
  .vh-console { grid-template-columns: 1fr; grid-template-rows: minmax(15rem, 42dvh) minmax(0, 1fr); overflow: auto; }
  .vh-console__sidebar { border-block-end: 1px solid var(--ui-border, #e4e4e7); border-inline-end: 0; }
}

@keyframes vh-console-spin { to { transform: rotate(360deg); } }
</style>
