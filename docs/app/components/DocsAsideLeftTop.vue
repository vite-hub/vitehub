<script setup lang="ts">
import { normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { useDocsSection } from "~/composables/useDocsSection";

const route = useRoute();
const currentSection = useDocsSection();
const sectionPath = computed(() => currentSection.value?.path || "/docs");
const sectionTitle = computed(() => currentSection.value?.title || "All products");
const sectionCategory = computed(() => {
  const category = currentSection.value?.category;

  return category && category !== currentSection.value?.title ? category : "Getting started";
});
const isDocsIndex = computed(() => normalizeDocsPath(route.path) === normalizeDocsPath(sectionPath.value));
</script>

<template>
  <div class="vh-sidebar-head">
    <UContentSearchButton
      :collapsed="false"
      class="vh-sidebar-search"
      :ui="{
        base: 'h-10 rounded-none border-0 border-b border-default bg-muted/20 ps-5 pe-5 text-muted hover:bg-muted/40 hover:text-highlighted',
        // Touch screens have no keyboard shortcut to show.
        trailing: 'ms-auto flex items-center gap-1 pointer-coarse:hidden',
      }"
    />
  </div>
</template>

<style scoped>
.vh-sidebar-search {
  height: 2.5rem;
  font-size: 0.875rem;
}
</style>
