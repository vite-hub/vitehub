<script setup lang="ts">
import type { DocsSearchSection } from "@vite-hub/docs"

// A result shows the page path over its heading. One line, "Page > Section > Heading", cut off the heading on a phone.
const manifest = useDocsManifest()
const icons = useDocsIcons()
const navigation = manifest.sections.map(section => ({
  title: section.title,
  path: section.path,
  icon: icons.section(section),
  children: section.pages.filter(page => page.navigation).map(page => ({ title: page.title, path: page.path, icon: icons.page(page) })),
}))
const links = navigation.map(item => ({ label: item.title, icon: item.icon, to: item.children[0]?.path ?? item.path }))

// The index loads when the dialog first opens, so pages do not pay for it.
const files = shallowRef<DocsSearchSection[]>()
const status = ref<"idle" | "loading" | "ready" | "error">("idle")
const { open } = useContentSearch()
watch(open, async (value) => {
  if (!value || status.value === "loading" || status.value === "ready") return
  status.value = "loading"
  try {
    files.value = await $fetch<DocsSearchSection[]>("/api/_docs/search.json")
    status.value = "ready"
  }
  catch {
    status.value = "error"
  }
})

// Nuxt UI builds the prefix as "Page > Section >".
function searchPath(prefix: string) {
  return prefix.replace(/\s*>$/, "").split(" > ").join(" / ")
}
</script>

<template>
  <LazyUContentSearch :files="files" :links="links" :navigation="navigation">
    <template #item-label="{ item }">
      <span v-if="item.prefix" class="vh-search-path">{{ searchPath(item.prefix) }}</span>
      <span class="vh-search-title">{{ item.label }}</span>
    </template>

    <template #empty="{ searchTerm }">
      <span v-if="status === 'error'">Search could not load. Reload the page to try again.</span>
      <span v-else-if="status !== 'ready'">Loading the search index…</span>
      <span v-else>No pages match “{{ searchTerm }}”.</span>
    </template>
  </LazyUContentSearch>
</template>
