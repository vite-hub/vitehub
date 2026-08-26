<script setup lang="ts">
import { AgentFileTree, AgentInvocationInspector, type AgentInvocationView } from '@vite-hub/ui'
import type { DropdownMenuItem, TabsItem } from '@nuxt/ui'
import { computed, nextTick, ref, watch } from 'vue'
import SessionCodePreview from './SessionCodePreview.vue'
import SessionTrace from './SessionTrace.vue'

type InspectorTab = 'details' | 'trace' | 'workspace'
type WorkspaceDescriptor = { paths: string[], pullRequest: number, repository: string, revision: string }
type WorkspaceFile = { content: string, path: string, revision: string, size: number }

const props = withDefaults(defineProps<{ invocation: AgentInvocationView, maximized?: boolean }>(), { maximized: false })
const emit = defineEmits<{ close: [], focusActivity: [activityId: string], toggleMaximized: [] }>()
const tab = defineModel<InspectorTab>('tab', { default: 'details' })
const activeSurface = defineModel<string>('activeSurface', { default: 'view:details' })
const openViews = defineModel<InspectorTab[]>('openViews', { default: () => ['details'] })
const openPaths = defineModel<string[]>('openPaths', { default: () => [] })
const selectedPath = defineModel<string | undefined>('selectedPath')
const viewMeta: Record<InspectorTab, { description: string, icon: string, label: string, shortcut: string }> = {
  details: { description: 'Review the run, runtime, and identifiers.', icon: 'i-lucide-circle-dot', label: 'Invocation', shortcut: 'I' },
  trace: { description: 'Follow spans, timings, and recorded attributes.', icon: 'i-lucide-list-tree', label: 'Trace', shortcut: 'T' },
  workspace: { description: 'Browse the immutable materialized workspace.', icon: 'i-lucide-folder-tree', label: 'Workspace', shortcut: 'W' },
}
const inspectorViews: InspectorTab[] = ['details', 'trace', 'workspace']
const workspace = ref<WorkspaceDescriptor>()
const workspaceError = ref<string>()
const workspaceLoading = ref(false)
const file = ref<WorkspaceFile>()
const fileError = ref<string>()
const fileLoading = ref(false)
const treeOpen = ref(true)
const tabstrip = ref<HTMLElement>()
const filesPanel = ref<HTMLElement>()
let workspaceRequest: AbortController | undefined
let fileRequest: AbortController | undefined

const workspaceLabel = computed(() => workspace.value
  ? `${workspace.value.repository}@${workspace.value.revision.slice(0, 7)}`
  : 'Materialized Workspace')
const breadcrumbs = computed(() => selectedPath.value?.split('/') ?? [])
type InspectorSurfaceItem = TabsItem & { icon: string, kind: 'file' | 'view', path?: string, view?: InspectorTab }
const surfaceItems = computed<InspectorSurfaceItem[]>(() => [
  ...openViews.value.map(view => ({ icon: viewMeta[view].icon, kind: 'view' as const, label: viewMeta[view].label, value: `view:${view}`, view })),
  ...openPaths.value.map(path => ({ icon: 'i-lucide-file-code-2', kind: 'file' as const, label: fileName(path), path, value: `file:${path}` })),
])
const activeSurfaceExists = computed(() => surfaceItems.value.some(item => String(item.value) === activeSurface.value))
const launcherItems = computed<DropdownMenuItem[]>(() => inspectorViews.map(view => ({
  icon: viewMeta[view].icon,
  label: viewMeta[view].label,
  kbds: [viewMeta[view].shortcut],
  onSelect: () => openView(view),
})))
const treeOptions = computed(() => ({
  density: 'compact' as const,
  onSelectionChange(paths: readonly string[]) {
    const path = paths.findLast(path => workspace.value?.paths.includes(path))
    if (path) selectedPath.value = path
  },
  search: true,
}))

watch(() => props.invocation.id, () => {
  workspaceRequest?.abort()
  fileRequest?.abort()
  workspace.value = undefined
  workspaceError.value = undefined
  selectedPath.value = undefined
  openPaths.value = []
  file.value = undefined
  fileError.value = undefined
  if (tab.value === 'workspace') void loadWorkspace()
})

watch(tab, (value) => {
  if (!openViews.value.includes(value)) openViews.value = [...openViews.value, value]
  if (value === 'workspace' && !workspace.value && !workspaceLoading.value) void loadWorkspace()
}, { immediate: true })

watch(selectedPath, (path) => {
  if (path) {
    if (!openPaths.value.includes(path)) openPaths.value = [...openPaths.value, path]
    tab.value = 'workspace'
    activeSurface.value = `file:${path}`
    void loadFile(path)
  }
})

watch(surfaceItems, (items) => {
  if (items.some(item => String(item.value) === activeSurface.value)) return
  const fallback = items.at(-1)?.value
  if (fallback !== undefined) activateSurface(fallback)
  else {
    activeSurface.value = ''
    selectedPath.value = undefined
  }
}, { flush: 'post' })

watch(activeSurface, async () => {
  await nextTick()
  tabstrip.value?.querySelector<HTMLElement>('[data-state="active"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

watch([workspace, treeOpen], async ([value, open]) => {
  if (!value || !open) return
  await nextTick()
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    const host = filesPanel.value?.querySelector<HTMLElement>('file-tree-container')
    const search = host?.shadowRoot?.querySelector<HTMLElement>('[data-file-tree-search-container]')
    if (!search) continue
    search.style.paddingTop = 'var(--trees-item-row-gap)'
    break
  }
})

function openView(value: InspectorTab) {
  if (!openViews.value.includes(value)) openViews.value = [...openViews.value, value]
  tab.value = value
  activeSurface.value = `view:${value}`
  if (value === 'workspace') {
    fileRequest?.abort()
    selectedPath.value = undefined
    file.value = undefined
    fileError.value = undefined
    fileLoading.value = false
  }
}

function openFile(path: string) {
  tab.value = 'workspace'
  selectedPath.value = path
  activeSurface.value = `file:${path}`
}

async function openWorkspaceInstructions() {
  openView('workspace')
  if (!workspace.value && !workspaceLoading.value) await loadWorkspace()
  const path = workspace.value?.paths
    .filter(path => /(^|\/)AGENTS\.md$/i.test(path))
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))[0]
  if (path) openFile(path)
}

function closeFile(path: string) {
  const index = openPaths.value.indexOf(path)
  if (index === -1) return
  openPaths.value = openPaths.value.filter(entry => entry !== path)
  if (selectedPath.value !== path) return
  const next = openPaths.value[index] ?? openPaths.value[index - 1]
  selectedPath.value = next
  const fallback = surfaceItems.value.at(-1)?.value
  activeSurface.value = next ? `file:${next}` : openViews.value.includes('workspace') ? 'view:workspace' : fallback === undefined ? '' : String(fallback)
  if (!next) {
    fileRequest?.abort()
    file.value = undefined
    fileError.value = undefined
  }
}

function activateSurface(value: string | number) {
  const id = String(value)
  if (id.startsWith('file:')) openFile(id.slice(5))
  else if (id.startsWith('view:')) openView(id.slice(5) as InspectorTab)
}

function closeSurface(item: InspectorSurfaceItem) {
  const itemId = item.value === undefined ? '' : String(item.value)
  const index = surfaceItems.value.findIndex(surface => String(surface.value) === itemId)
  const wasActive = activeSurface.value === itemId
    || (item.kind === 'view' && item.view === tab.value && !selectedPath.value)
    || (item.kind === 'file' && item.path === selectedPath.value)
  if (item.kind === 'file' && item.path) {
    closeFile(item.path)
    return
  }
  if (item.kind === 'view' && item.view) openViews.value = openViews.value.filter(view => view !== item.view)
  if (!wasActive) return
  const next = surfaceItems.value[index] ?? surfaceItems.value[index - 1]
  if (next?.value) activateSurface(next.value)
  else {
    activeSurface.value = ''
    selectedPath.value = undefined
  }
}

function fileName(path: string) {
  return path.split('/').at(-1) || path
}

async function loadWorkspace() {
  workspaceRequest?.abort()
  const controller = new AbortController()
  workspaceRequest = controller
  workspaceLoading.value = true
  workspaceError.value = undefined
  try {
    workspace.value = await request<WorkspaceDescriptor>(`/api/invocations/${encodeURIComponent(props.invocation.id)}/workspace`, controller.signal)
  }
  catch (error) {
    if (!controller.signal.aborted) workspaceError.value = message(error)
  }
  finally {
    if (!controller.signal.aborted && workspaceRequest === controller) workspaceLoading.value = false
  }
}

async function loadFile(path: string) {
  fileRequest?.abort()
  const controller = new AbortController()
  fileRequest = controller
  fileLoading.value = true
  fileError.value = undefined
  file.value = undefined
  try {
    file.value = await request<WorkspaceFile>(`/api/invocations/${encodeURIComponent(props.invocation.id)}/workspace?path=${encodeURIComponent(path)}`, controller.signal)
  }
  catch (error) {
    if (!controller.signal.aborted) fileError.value = message(error)
  }
  finally {
    if (!controller.signal.aborted && fileRequest === controller) fileLoading.value = false
  }
}

async function request<T>(path: string, signal: AbortSignal) {
  const response = await fetch(path, { signal })
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { statusMessage?: string, statusText?: string } | undefined
    throw new Error(payload?.statusMessage || payload?.statusText || `Request failed with status ${response.status}.`)
  }
  return await response.json() as T
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'This session data is unavailable.'
}
</script>

<template>
  <aside class="session-inspector">
    <header class="session-inspector__header">
      <div ref="tabstrip" class="session-inspector__tabstrip">
        <UTabs
          v-if="surfaceItems.length"
          :model-value="activeSurface"
          :items="surfaceItems"
          :content="false"
          class="session-inspector__tabs"
          color="neutral"
          size="xs"
          variant="pill"
          :ui="{ root: 'min-w-0', list: 'w-max min-w-full gap-1 bg-transparent p-0', indicator: 'hidden', trigger: 'group/tab h-6 max-w-36 shrink-0 grow-0 cursor-pointer justify-start gap-0.5 rounded-md px-1.5 py-0 text-xs', label: 'truncate' }"
          @update:model-value="activateSurface"
        >
          <template #leading="{ item }">
            <button type="button" class="session-inspector__tab-close" :aria-label="`Close ${item.label}`" @click.stop="closeSurface(item)">
              <UIcon :name="item.icon" class="session-inspector__surface-icon" />
              <UIcon name="i-lucide-x" class="session-inspector__surface-close" />
            </button>
          </template>
        </UTabs>
        <UDropdownMenu
          :items="launcherItems"
          :content="{ align: 'start', side: 'bottom', sideOffset: 6 }"
          size="sm"
          :ui="{ content: 'session-inspector__launcher-menu w-44 rounded-lg p-1 shadow-[0_16px_40px_-18px_rgb(0_0_0/35%)] ring-1 ring-default', viewport: 'gap-0', item: 'session-inspector__launcher-item min-h-7 gap-2 rounded-sm px-2 py-1', itemLeadingIcon: 'size-4 shrink-0 text-muted', itemWrapper: 'min-w-0 flex-1', itemLabel: 'truncate text-sm', itemTrailing: 'ms-auto', itemTrailingKbds: 'ms-auto' }"
        >
          <UButton class="session-inspector__icon-button" icon="i-lucide-plus" color="neutral" variant="ghost" size="xs" aria-label="Open tab" />
        </UDropdownMenu>
      </div>
      <div class="session-inspector__actions">
        <UTooltip :text="props.maximized ? 'Restore panel size' : 'Maximize panel'"><UButton class="session-inspector__icon-button" :icon="props.maximized ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'" color="neutral" variant="ghost" size="xs" :aria-label="props.maximized ? 'Restore panel size' : 'Maximize panel'" :aria-pressed="props.maximized" @click="emit('toggleMaximized')" /></UTooltip>
        <UTooltip text="Toggle right panel"><UButton class="session-inspector__icon-button" icon="i-lucide-panel-right" color="neutral" variant="ghost" size="xs" aria-label="Toggle right panel" aria-pressed="true" @click="emit('close')" /></UTooltip>
      </div>
    </header>

    <div v-if="!activeSurfaceExists" class="session-inspector__empty">
      <div class="session-inspector__empty-copy">
        <strong>Open a tab</strong>
        <span>Choose what to inspect in this Agent Invocation.</span>
      </div>
      <div class="session-inspector__surface-launcher">
        <button v-for="view in inspectorViews" :key="view" type="button" @click="openView(view)">
          <UKbd>{{ viewMeta[view].shortcut }}</UKbd>
          <span><UIcon :name="viewMeta[view].icon" />{{ viewMeta[view].label }}</span>
          <small>{{ viewMeta[view].description }}</small>
        </button>
      </div>
    </div>

    <AgentInvocationInspector v-else-if="tab === 'details'" :invocation="invocation" class="session-inspector__details">
      <template v-if="!invocation.configuration?.instructions?.length" #metadata>
        <section class="session-inspector__instruction-fallback">
          <h4>System instructions</h4>
          <p>Resolved instructions were not recorded for this invocation.</p>
          <button type="button" @click="openWorkspaceInstructions"><UIcon name="i-lucide-file-text" />Open AGENTS.md in Workspace<UIcon name="i-lucide-arrow-right" /></button>
        </section>
      </template>
    </AgentInvocationInspector>

    <SessionTrace v-else-if="tab === 'trace'" :invocation="invocation" @focus-activity="emit('focusActivity', $event)" />

    <div v-else class="session-inspector__workspace">
      <div class="session-inspector__breadcrumbs">
        <span class="session-inspector__repository">{{ workspace?.repository || 'Workspace' }}</span>
        <template v-for="(segment, index) in breadcrumbs" :key="`${segment}-${index}`"><UIcon name="i-lucide-chevron-right" /><span :data-current="index === breadcrumbs.length - 1">{{ segment }}</span></template>
        <small v-if="file">{{ file.size }} bytes</small>
        <div class="session-inspector__workspace-actions">
          <UTooltip text="Reload Workspace"><UButton icon="i-lucide-rotate-cw" color="neutral" variant="ghost" size="xs" aria-label="Reload Workspace" @click="loadWorkspace" /></UTooltip>
          <UTooltip :text="treeOpen ? 'Hide file tree' : 'Show file tree'"><UButton icon="i-lucide-folder-tree" color="neutral" variant="ghost" size="xs" :aria-label="treeOpen ? 'Hide file tree' : 'Show file tree'" :aria-pressed="treeOpen" @click="treeOpen = !treeOpen" /></UTooltip>
        </div>
      </div>
      <div v-if="workspaceLoading" class="session-inspector__state"><UIcon name="i-lucide-loader-circle" class="animate-spin" />Loading Workspace…</div>
      <UEmpty v-else-if="workspaceError" icon="i-lucide-folder-x" title="Workspace unavailable" :description="workspaceError" :actions="[{ label: 'Try again', onClick: loadWorkspace }]" />
      <template v-else-if="workspace">
        <div class="session-inspector__workspace-body" :data-tree-open="treeOpen">
          <div class="session-inspector__file">
          <div v-if="!selectedPath" class="session-inspector__snapshot">
            <UIcon name="i-lucide-folder-git-2" />
            <span class="session-inspector__eyebrow">Immutable snapshot</span>
            <strong>{{ workspaceLabel }}</strong>
            <small>{{ workspace.paths.length }} files · PR #{{ workspace.pullRequest }}</small>
          </div>
          <div v-if="fileLoading" class="session-inspector__state"><UIcon name="i-lucide-loader-circle" class="animate-spin" />Loading file…</div>
          <div v-else-if="fileError" class="session-inspector__state text-error"><UIcon name="i-lucide-file-warning" />{{ fileError }}</div>
          <SessionCodePreview v-else-if="selectedPath && file" :content="file.content" :path="file.path" />
          <div v-else-if="selectedPath" class="session-inspector__state"><UIcon name="i-lucide-mouse-pointer-2" />Select a file to preview it.</div>
          </div>
          <aside v-if="treeOpen" ref="filesPanel" class="session-inspector__files">
            <AgentFileTree class="session-inspector__tree" :paths="workspace.paths" :options="treeOptions" />
          </aside>
        </div>
      </template>
    </div>
  </aside>
</template>
