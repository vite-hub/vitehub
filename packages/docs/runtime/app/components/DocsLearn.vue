<script setup lang="ts">
import { webContainer, Workspace, type WorkspaceExample, type WorkspaceSlotProps, type WorkspaceStep } from "@vite-hub/ui/workspace"
import { fetchSnapshot } from "@vite-hub/web-container"
import { docsAppPath } from "#docs/navigation"
import { frameworkNodes, parseCurl, requestScript, restartsDevServer, splitTutorialDocument, tutorialStepFiles, tutorialWorkspaceFiles } from "#docs/runnable"
import DocsLearnCodePre from "./DocsLearnCodePre.vue"
import DocsLearnFile from "./DocsLearnFile.vue"
import { docsLearnActionsKey, docsLearnGuideNodes, docsLearnStepNodes } from "../utils/docs-learn"

import type { DocsLearnData } from "#docs/runnable"
import type { DocsLearnActions } from "../utils/docs-learn"
import type { DocsPageResponse } from "@vite-hub/docs"

type Files = Record<string, string>

const props = defineProps<{ response: DocsPageResponse, data: DocsLearnData }>()
const tutorial = props.data.tutorial
const route = useRoute()
const router = useRouter()
const { site, appBase } = useDocsConfig()

let lessonDocument = props.response.document
if (tutorial.page !== props.response.page.path) {
  const { data } = await useFetch<DocsPageResponse>(docsAppPath(`/api/_docs/page${tutorial.page}.json`, appBase), { key: `docs:${tutorial.page}` })
  if (!data.value) throw createError({ statusCode: 404, statusMessage: `The lesson page ${tutorial.page} was not found`, fatal: true })
  lessonDocument = data.value.document
  useHead({ link: [{ rel: "canonical", href: `${site.url}${docsAppPath(tutorial.page, appBase)}` }] })
}
const lesson = splitTutorialDocument(frameworkNodes(lessonDocument.nodes, "Vite"))
const steps: WorkspaceStep[] = tutorial.steps.map(item => ({ title: item.title }))
const total = steps.length

const step = computed({
  get: () => {
    const value = Number(route.query.step)
    return Number.isInteger(value) && value >= 1 && value <= total ? value - 1 : 0
  },
  set: value => void router.replace({ query: { ...route.query, step: value === 0 ? undefined : String(value + 1) } }),
})

const paths = [...new Set([...Object.keys(tutorial.files), ...tutorial.steps.flatMap(item => Object.keys(item.files))])]
const guideNodes = computed(() => docsLearnGuideNodes([
  ...step.value === 0 ? lesson.intro : [],
  ...docsLearnStepNodes(lesson.steps[step.value]),
  ...step.value === total - 1 ? lesson.outro : [],
], new Set(paths)))

const stepFiles = (index: number, state: "start" | "solution"): Files => tutorialStepFiles(tutorial, index, state)

const prebuilt = tutorial.snapshot
const snapshot = prebuilt && (() => fetchSnapshot(prebuilt.parts, { cache: `vitehub-tutorial-${tutorial.slug}`, sha256: prebuilt.sha256 }))

const baseline = shallowRef<Files>(stepFiles(step.value, "start"))
const examples = computed<WorkspaceExample[]>(() => [
  { id: tutorial.slug, label: tutorial.title, files: baseline.value, preview: props.data.preview },
])
const runner = webContainer({ port: props.data.port, snapshot: () => snapshot || undefined })
type Container = NonNullable<typeof runner.workspace.value>
const selected = ref(Object.keys(tutorial.steps[step.value]?.files ?? {})[0])
const open = ref(false)

const edited = computed(() => {
  const files = runner.workspace.value?.files.value
  if (!files) return []
  const all = new Set([...Object.keys(baseline.value), ...Object.keys(files)])
  return [...all].filter(path => baseline.value[path] !== files[path])
})

async function write(workspace: Container, next: Files) {
  const restart = restartsDevServer(workspace.files.value, next) && ["starting", "ready"].includes(workspace.status.value)
  await workspace.setFiles(next, { mode: "replace" })
  if (restart) await workspace.restart()
}

async function load(target: Files) {
  pendingStep.value = undefined
  const workspace = runner.workspace.value
  const next = workspace && tutorialWorkspaceFiles(tutorial, workspace.files.value, target)
  baseline.value = target
  if (workspace && next) await write(workspace, next)
}

const pendingStep = ref<number>()
watch(step, (index) => {
  const first = Object.keys(tutorial.steps[index]?.files ?? {})[0]
  if (first) selected.value = first
  if (!runner.workspace.value || edited.value.length === 0) void load(stepFiles(index, "start"))
  else pendingStep.value = index
})
function loadPending() {
  if (pendingStep.value !== undefined) void load(stepFiles(pendingStep.value, "start"))
}
function keepMine() {
  if (pendingStep.value === undefined) return
  baseline.value = stepFiles(pendingStep.value, "start")
  pendingStep.value = undefined
}
function solve(guard: WorkspaceSlotProps["guard"]) {
  guard(`Replace your changes with the solution of step ${step.value + 1}?`, "Replace files", () => void load(stepFiles(step.value, "solution")))
}

const requestPath = "node_modules/.vitehub-tutorial-request.mjs"
async function run(command: string): Promise<string> {
  const request = parseCurl(command)
  const container = runner.workspace.value?.container.value
  if (!request || !container) return "The workspace is not running."
  await container.fs.mkdir("node_modules", { recursive: true })
  await container.fs.writeFile(requestPath, requestScript(request))
  const process = await container.run(["node", requestPath])
  void process.output.cancel()
  await process.exit
  return (await process.text()).replace(/\u001B\[[\d;]*m/g, "").trim()
}

const actions: DocsLearnActions = {
  get available() {
    return !!runner.workspace.value
  },
  get running() {
    return runner.workspace.value?.status.value === "ready" && !!runner.workspace.value.previewUrl.value
  },
  paths,
  show(path: string) {
    const workspace = runner.workspace.value
    if (workspace && !(path in workspace.files.value)) void write(workspace, { ...workspace.files.value, [path]: "" })
    selected.value = path
  },
  run,
}
provide(docsLearnActionsKey, actions)
const guideComponents = { pre: DocsLearnCodePre, DocsLearnFile }
</script>

<template>
  <div class="vh-docs-workspace" :data-path="response.page.path">
    <Workspace
      v-model:open="open"
      v-model:selected="selected"
      v-model:step="step"
      :steps="steps"
      :guide="data.guide"
      :examples="examples"
      :runner="runner"
      :share="false"
      label="lesson"
    >
      <template #guide>
        <!-- A lesson that takes its steps from a docs page links back to that page. -->
        <p v-if="tutorial.page !== response.page.path" class="mb-4 text-sm text-muted">
          <NuxtLink :to="tutorial.page" class="hover:text-highlighted">Read in the docs</NuxtLink>
        </p>
        <UPageBody prose class="docs-content docs-tutorial-content !my-0 !px-0 !pb-0">
          <DocsMarkdown :key="step" :document="{ nodes: guideNodes, toc: [] }" :components="guideComponents" />
        </UPageBody>
      </template>

      <template #bar-actions="{ guard }">
        <UButton color="neutral" variant="outline" label="Solve" icon="i-lucide-wand-sparkles" @click="solve(guard)" />
      </template>

      <template v-if="pendingStep !== undefined" #banner>
        <div class="vh-docs-learn-bar" role="status">
          <span class="min-w-0 flex-1">You changed {{ edited.length === 1 ? "1 file" : `${edited.length} files` }}. Step {{ pendingStep + 1 }} has its own version.</span>
          <UButton size="xs" color="neutral" variant="outline" :label="`Load step ${pendingStep + 1}`" @click="loadPending" />
          <UButton size="xs" color="neutral" variant="ghost" label="Keep mine" @click="keepMine" />
        </div>
      </template>

      <template #intro>
        <h1 class="text-balance text-3xl font-semibold text-highlighted">{{ response.page.sourceTitle }}</h1>
        <p v-if="response.page.description" class="mt-3 text-muted">{{ response.page.description }}</p>
      </template>

      <!-- Without the workspace, such as on a phone, the page is the whole lesson. -->
      <template #fallback>
        <UPageBody prose class="docs-content docs-tutorial-content !px-0 !pb-0">
          <DocsMarkdown :document="lessonDocument" />
        </UPageBody>
      </template>
    </Workspace>
  </div>
</template>

<style scoped>
.vh-docs-workspace {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.vh-docs-workspace :deep(.vh-workspace) {
  flex: 1 1 0;
  min-height: 0;
}

.vh-docs-workspace :deep(.vh-workspace-gate-content) {
  width: 100%;
  max-width: calc(65ch + 2rem);
  margin-inline: auto;
  padding: 2.5rem 1rem 4rem;
}

.vh-docs-learn-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated);
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
}
</style>
