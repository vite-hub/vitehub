<script setup lang="ts">
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionForPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const currentSection = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
</script>

<template>
  <!-- The rail switches sections, so the panel names the current one and lists its pages. -->
  <h2 class="vh-docs-panel-title">{{ currentSection?.title || "All docs" }}</h2>
</template>

<style scoped>
.vh-docs-panel-title {
  flex: none;
  margin: 0;
  padding: 0 1rem;
  overflow: hidden;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 2.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
