<script setup lang="ts">
import { AgentInvocation } from "@vite-hub/ui"
import { useAgentInvocation, useAgentInvocations } from "vite-hub/agent/vue"
import { computed, ref, watch } from "vue"

import type { AgentInvocationSummary } from "vite-hub/agent"
import type { AgentInvocationView } from "@vite-hub/ui"

type ConsoleSession = {
  agentName?: string
  id: string
  invocations: AgentInvocationSummary[]
  updatedAt: string
}

const route = useRoute()
const router = useRouter()
const selectedInvocationId = ref<string>()
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
  return invocation ? { ...invocation, observations: detail.observations.value } : undefined
})

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : error ? "The console could not load this data." : undefined
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(date)
}

async function selectSession(session: ConsoleSession): Promise<void> {
  await router.push({ name: "vitehub-console-agents", params: { session: session.id } })
}

watch(sessions, async (next) => {
  if (next.length && !next.some(session => session.id === routeSession.value)) await selectSession(next[0]!)
}, { immediate: true })

watch(selectedSession, (session) => {
  selectedInvocationId.value = session?.invocations.some(invocation => invocation.id === selectedInvocationId.value)
    ? selectedInvocationId.value
    : session?.invocations[0]?.id
}, { immediate: true })
</script>

<template>
  <div class="vh-console">
    <header class="vh-console__header">
      <NuxtLink to="/_vitehub/agents"><strong>ViteHub</strong> Console</NuxtLink>
      <span>Read-only</span>
      <UButton
        color="neutral"
        icon="i-lucide-refresh-cw"
        label="Refresh"
        size="sm"
        variant="outline"
        :loading="list.isLoading.value"
        @click="Promise.all([list.refresh(), detail.refresh()])"
      />
    </header>

    <div class="vh-console__workspace">
      <aside aria-label="Agent sessions">
        <div class="vh-console__heading">
          <h1>Agent sessions</h1>
          <UBadge color="neutral" variant="subtle">{{ sessions.length }}</UBadge>
        </div>
        <div v-if="errorMessage(list.error.value)" class="vh-console__notice" role="alert">
          {{ errorMessage(list.error.value) }}
        </div>
        <div v-else-if="list.isLoading.value && !sessions.length" class="vh-console__notice">Loading sessions…</div>
        <div v-else-if="!sessions.length" class="vh-console__notice">The first Agent invocation will appear here.</div>
        <button
          v-for="session in sessions"
          :key="session.id"
          class="vh-console__session"
          :class="{ 'is-selected': selectedSession?.id === session.id }"
          type="button"
          @click="selectSession(session)"
        >
          <strong>{{ session.agentName || "Agent session" }}</strong>
          <small>{{ session.invocations.length }} run{{ session.invocations.length === 1 ? "" : "s" }} · {{ formatTime(session.updatedAt) }}</small>
          <code>{{ session.id }}</code>
        </button>
        <UButton
          v-if="list.cursor.value"
          block
          color="neutral"
          label="Load older"
          size="sm"
          variant="soft"
          :loading="list.isLoadingMore.value"
          @click="list.loadMore"
        />
      </aside>

      <main>
        <div v-if="!selectedSession" class="vh-console__notice">Select a session to inspect its trace.</div>
        <template v-else>
          <div class="vh-console__heading">
            <div>
              <h2>{{ selectedSession.agentName || "Agent session" }}</h2>
              <code>{{ selectedSession.id }}</code>
            </div>
          </div>
          <nav class="vh-console__runs" aria-label="Session invocations">
            <button
              v-for="invocation in selectedSession.invocations"
              :key="invocation.id"
              :aria-pressed="selectedInvocationId === invocation.id"
              type="button"
              @click="selectedInvocationId = invocation.id"
            >
              {{ formatTime(invocation.createdAt) }} · {{ invocation.status }}
            </button>
          </nav>
          <div v-if="errorMessage(detail.error.value)" class="vh-console__notice" role="alert">
            {{ errorMessage(detail.error.value) }}
          </div>
          <div v-else-if="detail.isLoading.value && !invocationView" class="vh-console__notice">Loading invocation…</div>
          <AgentInvocation v-else-if="invocationView" :invocation="invocationView" />
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.vh-console { background: var(--ui-bg, Canvas); color: var(--ui-text, CanvasText); min-height: 100dvh; }
.vh-console__header { align-items: center; border-bottom: 1px solid var(--ui-border, #d4d4d8); display: flex; gap: 1rem; min-height: 4rem; padding: 0 1.25rem; }
.vh-console__header a { color: inherit; flex: 1; text-decoration: none; }
.vh-console__header span { color: var(--ui-text-muted, #71717a); font-size: .8rem; }
.vh-console__workspace { display: grid; grid-template-columns: minmax(17rem, 23rem) minmax(0, 1fr); min-height: calc(100dvh - 4rem); }
.vh-console__workspace > * { min-width: 0; padding: 1.25rem; }
.vh-console__workspace aside { border-right: 1px solid var(--ui-border, #d4d4d8); }
.vh-console__heading { align-items: center; display: flex; justify-content: space-between; margin-bottom: 1rem; }
.vh-console__heading h1, .vh-console__heading h2 { font-size: 1rem; margin: 0; }
.vh-console__heading code, .vh-console__session code { color: var(--ui-text-muted, #71717a); font-size: .7rem; overflow-wrap: anywhere; }
.vh-console__session { background: transparent; border: 1px solid transparent; border-radius: .55rem; color: inherit; display: grid; gap: .25rem; margin-bottom: .5rem; padding: .75rem; text-align: left; width: 100%; }
.vh-console__session:hover, .vh-console__session.is-selected { background: var(--ui-bg-elevated, #f4f4f5); border-color: var(--ui-border, #d4d4d8); }
.vh-console__session small { color: var(--ui-text-muted, #71717a); }
.vh-console__notice { color: var(--ui-text-muted, #71717a); padding: 1rem 0; }
.vh-console__runs { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
.vh-console__runs button { background: transparent; border: 1px solid var(--ui-border, #d4d4d8); border-radius: 999px; color: inherit; padding: .4rem .7rem; }
.vh-console__runs button[aria-pressed="true"] { background: var(--ui-bg-elevated, #f4f4f5); }
@media (max-width: 760px) {
  .vh-console__workspace { grid-template-columns: 1fr; }
  .vh-console__workspace aside { border-bottom: 1px solid var(--ui-border, #d4d4d8); border-right: 0; }
}
</style>
