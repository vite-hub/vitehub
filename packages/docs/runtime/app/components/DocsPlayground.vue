<script setup lang="ts">
import { defineAsyncComponent } from "vue"
import { render, webContainer, Workspace, type WorkspaceExample, type WorkspaceRunner, type WorkspaceSnapshot } from "@vite-hub/ui/workspace"
import { fetchSnapshot } from "@vite-hub/web-container"
import { docsAppPath } from "#docs/navigation"
import { docsPlaygroundExampleQuery } from "../utils/docs-playground"

import type { DocsWorkspaceData } from "#docs/runnable"
import type { DocsPageResponse } from "@vite-hub/docs"

const props = defineProps<{ response: DocsPageResponse, data: Exclude<DocsWorkspaceData, { layout: "learn" }> }>()
const route = useRoute()
const router = useRouter()
const { page } = props.response
const { appBase } = useDocsConfig()

const snapshots = new Map<string, WorkspaceSnapshot>()
const snapshotOf = new Map<string, string>()
const examples: WorkspaceExample[] = props.data.examples.map(({ snapshot: prebuilt, snapshotOf: key, ...example }) => {
  if (key && prebuilt && !snapshots.has(key)) {
    snapshots.set(key, () => fetchSnapshot(prebuilt.parts, { cache: `vitehub-tutorial-${key}`, sha256: prebuilt.sha256 }))
  }
  if (key) snapshotOf.set(example.id, key)
  return example
})
const load = props.data.render
const runner: WorkspaceRunner = load
  ? render(async files => (await load()).default(files))
  : webContainer({ port: props.data.port, snapshot: example => snapshots.get(snapshotOf.get(example.id) ?? "") })
const tabs = (props.data.tabs ?? []).map(tab => ({ value: tab.value, label: tab.label, component: defineAsyncComponent(async () => (await tab.component()).default) }))
const tabItems = tabs.map(({ value, label }) => ({ value, label }))

const queried = [route.query.example, route.query.template].find(value => typeof value === "string" && examples.some(example => example.id === value))
const example = typeof queried === "string" ? queried : undefined
const open = ref(false)

function keep(id: string) {
  void router.replace({ query: { ...route.query, example: docsPlaygroundExampleQuery(examples, id), template: undefined }, hash: "" })
}
function exampleHref(id: string) {
  const query = docsPlaygroundExampleQuery(examples, id)
  return docsAppPath(query ? `${page.path}?example=${encodeURIComponent(query)}` : page.path, appBase)
}
</script>

<template>
  <div class="vh-docs-workspace" :data-path="page.path">
    <Workspace
      v-model:open="open"
      :examples="examples"
      :example="example"
      :runner="runner"
      :tabs="tabItems"
      :start="examples.length > 1 && !example"
      label="playground"
      @update:example="keep"
    >
      <template v-for="tab in tabs" :key="tab.value" #[tab.value]>
        <component :is="tab.component" />
      </template>

      <template #intro>
        <h1 class="text-balance text-3xl font-semibold text-highlighted">{{ page.sourceTitle }}</h1>
        <p v-if="page.description" class="mt-3 text-muted">{{ page.description }}</p>
      </template>

      <!-- Without the workspace, such as on a phone, the page shows its own text and the examples. -->
      <template #fallback>
        <UPageBody prose class="docs-content !px-0 !pb-0">
          <DocsMarkdown :document="response.document" />
        </UPageBody>
        <h2 class="mt-10 text-lg font-semibold text-highlighted">Examples</h2>
        <ul class="vh-docs-playground-list">
          <li v-for="item in examples" :key="item.id">
            <!-- A new document boots the example, as a link from another page does. -->
            <a :href="exampleHref(item.id)" class="font-medium text-highlighted">{{ item.label }}</a>
            <span v-if="item.description" class="text-muted">: {{ item.description }}</span>
          </li>
        </ul>
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

.vh-docs-playground-list {
  margin-top: 0.75rem;
  display: grid;
  gap: 0.5rem;
  padding-inline-start: 1.25rem;
  list-style: disc;
}
</style>
