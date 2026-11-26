<script lang="ts">
import { createDocsSearch, docsAppPath, docsSectionHome } from "#docs/navigation"

import type { DocsSearchSection } from "@vite-hub/docs"

type DocsSearch = ReturnType<typeof createDocsSearch>

let loading: Promise<DocsSearch> | undefined

function loadDocsSearch(url: string): Promise<DocsSearch> {
  if (!import.meta.dev && loading) return loading
  const request = $fetch<DocsSearchSection[]>(url).then(createDocsSearch)
  if (import.meta.dev) return request
  return loading = request.catch((error: unknown) => {
    loading = undefined
    throw error
  })
}

function savesData(): boolean {
  const connection: { saveData?: boolean } | undefined = Reflect.get(navigator, "connection")
  return connection?.saveData === true
}
</script>

<script setup lang="ts">
const { appBase } = useDocsConfig()
const manifest = useDocsManifest()
const icons = useDocsIcons()
const navigation = manifest.sections.map(section => ({
  title: section.title,
  path: section.path,
  icon: icons.section(section),
  children: section.pages.filter(page => page.navigation).map(page => ({ title: page.title, path: page.path, icon: icons.page(page) })),
}))
const links = navigation.map((item, index) => ({ label: item.title, icon: item.icon, to: docsSectionHome(manifest.sections[index]!) }))

const status = ref<"idle" | "loading" | "ready" | "error">("idle")
let rank: DocsSearch | undefined
const { open } = useContentSearch()

async function load() {
  if (status.value === "loading" || status.value === "ready") return
  status.value = "loading"
  try {
    rank = await loadDocsSearch(docsAppPath("/api/_docs/search.json", appBase))
    status.value = "ready"
  }
  catch {
    status.value = "error"
  }
}

watch(open, (value) => {
  if (value) void load()
})
if (!import.meta.dev && !savesData()) onNuxtReady(() => load())

async function search(query: string, options?: { limit?: number }) {
  return rank?.(query, options?.limit ?? 30) ?? []
}

const searchTerm = ref("")

function searchPath(prefix: string) {
  return prefix.replace(/\s*>$/, "").split(" > ").join(" / ")
}
</script>

<template>
  <LazyUContentSearch
    v-model:search-term="searchTerm"
    :links="searchTerm ? [] : links"
    :navigation="navigation"
    :search="search"
    :search-status="status"
    :search-delay="0"
    :fuse="{ resultLimit: 30 }"
  >
    <template #item-label="{ item }">
      <span v-if="item.prefix" class="vh-search-path">{{ searchPath(item.prefix) }}</span>
      <span class="vh-search-title">{{ item.label }}</span>
    </template>

    <template #empty="{ searchTerm: term }">
      <span v-if="status === 'error'">Search could not load. Reload the page to try again.</span>
      <span v-else-if="status !== 'ready'">Loading the search index…</span>
      <span v-else>No pages match “{{ term }}”.</span>
    </template>
  </LazyUContentSearch>
</template>
