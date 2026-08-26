<script setup lang="ts">
import { AgentInvocation, type AgentInvocationView } from '@vite-hub/ui'
import { ref } from 'vue'
import { invocationProject, invocationTitle } from '../invocation-display'

type InspectorTab = 'details' | 'agent' | 'trace' | 'workspace'

const props = defineProps<{
  detailsOpen: boolean
  errorMessage?: string
  inspectorTab: InspectorTab
  invocation?: AgentInvocationView
  loading: boolean
  pullRequestUrl?: string
}>()

const emit = defineEmits<{
  inspect: [target: InspectorTab]
  refresh: []
  togglePanel: []
}>()

const root = ref<HTMLElement>()
let focusTimer: ReturnType<typeof setTimeout> | undefined

function focusActivity(activityId: string) {
  const activity = root.value?.querySelector<HTMLElement>(`.vh-invocation-activity[data-activity-id="${CSS.escape(activityId)}"]`)
  if (!activity) return false
  const work = activity.closest<HTMLDetailsElement>('.vh-invocation-work__details')
  if (work) work.open = true
  root.value?.querySelector<HTMLElement>('.vh-invocation-activity[data-trace-focus="true"]')?.removeAttribute('data-trace-focus')
  activity.dataset.traceFocus = 'true'
  activity.scrollIntoView({ block: 'center', inline: 'nearest' })
  if (focusTimer) clearTimeout(focusTimer)
  focusTimer = setTimeout(() => activity.removeAttribute('data-trace-focus'), 2_400)
  return true
}

defineExpose({ focusActivity })
</script>

<template>
  <section ref="root" class="session-thread">
    <UDashboardNavbar class="session-navbar" :title="props.invocation ? invocationTitle(props.invocation) : 'Babysitter'" :ui="{ root: 'border-0', title: 'min-w-0 flex-1' }">
      <template #title>
        <div v-if="props.invocation" class="flex min-w-0 items-center gap-2 text-sm">
          <UIcon name="i-lucide-folder" class="size-4 shrink-0 text-muted" />
          <span class="max-w-40 shrink-0 truncate font-normal text-muted">{{ invocationProject(props.invocation) }}</span>
          <span class="text-dimmed" aria-hidden="true">/</span>
          <strong class="min-w-0 truncate font-medium text-highlighted">{{ invocationTitle(props.invocation) }}</strong>
        </div>
        <span v-else class="text-sm font-medium">Babysitter</span>
      </template>
      <template #right>
        <div class="session-toolbar">
          <UTooltip v-if="props.pullRequestUrl" text="Open pull request">
            <UButton class="session-toolbar__button" :to="props.pullRequestUrl" target="_blank" color="neutral" variant="ghost" size="sm" aria-label="Open pull request">
              <svg class="session-toolbar__brand-icon" aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .7A11.3 11.3 0 0 0 8.4 22.8c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.8.1-.8.1-.8 1.3.1 1.9 1.3 1.9 1.3 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.6 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.3 11.3 0 0 0 12 .7Z" /></svg>
            </UButton>
          </UTooltip>
          <UTooltip v-if="props.invocation && !props.detailsOpen" text="Toggle right panel"><UButton class="session-toolbar__button" icon="i-lucide-panel-right" color="neutral" variant="ghost" size="sm" aria-label="Toggle right panel" aria-pressed="false" @click="emit('togglePanel')" /></UTooltip>
        </div>
      </template>
    </UDashboardNavbar>

    <div class="session-thread__body" aria-live="polite">
      <UEmpty v-if="props.errorMessage" class="h-full" icon="i-lucide-cloud-off" title="Could not load this session" :description="props.errorMessage">
        <template #actions><UButton icon="i-lucide-refresh-cw" label="Try again" color="neutral" variant="soft" @click="emit('refresh')" /></template>
      </UEmpty>
      <div v-else-if="props.loading && !props.invocation" class="flex h-full items-center justify-center"><UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" /></div>
      <AgentInvocation v-else-if="props.invocation" :header="false" :invocation="props.invocation" class="h-full" @inspect="emit('inspect', $event)" />
      <div v-else class="flex h-full items-center justify-center text-sm text-muted">Select a session to inspect its work.</div>
    </div>
  </section>
</template>
