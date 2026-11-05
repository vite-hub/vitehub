<script setup lang="ts">
import { createDocsSearch, docsAppPath, docsManifestPages, docsSectionHome } from "#docs/navigation"

import type { DocsSearchSection } from "@vite-hub/docs"

// A result shows the page path over its heading. One line, "Page > Section > Heading", cut off the heading on a phone.
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
// Root and standalone pages are searchable too; navigation: false keeps any page out of the results.
const listed = new Set(docsManifestPages(manifest).filter(page => page.navigation).map(page => page.path))

// The index loads when the dialog first opens, so pages do not pay for it.
const status = ref<"idle" | "loading" | "ready" | "error">("idle")
let rank: ReturnType<typeof createDocsSearch> | undefined
const { open } = useContentSearch()
watch(open, async (value) => {
  if (!value || status.value === "loading" || status.value === "ready") return
  status.value = "loading"
  try {
    const records = await $fetch<DocsSearchSection[]>(docsAppPath("/api/_docs/search.json", appBase))
    rank = createDocsSearch(records.filter(record => listed.has(record.id.split("#")[0] ?? record.id)))
    status.value = "ready"
  }
  catch {
    status.value = "error"
  }
})

async function search(query: string, options?: { limit?: number }) {
  return rank?.(query, options?.limit ?? 30) ?? []
}

// The section list helps before the first key press. After it, the ranked results are the whole list.
const searchTerm = ref("")

// Nuxt UI builds the prefix as "Page > Section >".
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
