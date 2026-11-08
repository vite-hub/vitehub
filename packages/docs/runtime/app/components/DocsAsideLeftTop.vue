<script setup lang="ts">
import { docsSidebarGroup } from "#docs/navigation"

// Search sits in the header, so the panel opens with the name of what it lists: the group of the current section, or
// the section itself.
const { groups } = useDocsConfig()
const manifest = useDocsManifest()
const section = useDocsSection()
const title = computed(() => {
  if (!section.value) return null
  return docsSidebarGroup(manifest, section.value, groups)?.title ?? section.value.title
})
</script>

<template>
  <p v-if="title" class="vh-docs-panel-title">{{ title }}</p>
</template>

<style scoped>
.vh-docs-panel-title {
  flex: none;
  margin: 0;
  padding: 1rem 1rem 0.5rem;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.4;
}
</style>
