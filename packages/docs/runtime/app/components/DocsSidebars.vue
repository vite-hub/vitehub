<script setup lang="ts">
import { docsSingleList } from "#docs/navigation"

defineProps<{
  /** Shows the page panel next to the rail. Outside a section the panel lists every product. */
  panel: boolean
  /** Shows the rail labels, for the mobile menu where touch has no hover to expand the rail. */
  labeled?: boolean
}>()

// A small site has no rail. The panel lists every section with its pages.
const single = docsSingleList(useDocsManifest(), useDocsConfig().icons)
</script>

<template>
  <div class="vh-docs-sidebars">
    <DocsRail v-if="!single" :labeled="labeled" />
    <div v-if="panel" class="vh-docs-panel" :class="{ 'is-single': single }">
      <DocsAsideLeftTop :brand="single" />
      <DocsAsideLeftBody />
      <DocsAsideFooter />
    </div>
  </div>
</template>

<style scoped>
/* The parent sets the height. The rail and the panel each scroll inside it. Nothing here clips, so the expanded rail can cover the panel. */
.vh-docs-sidebars {
  display: flex;
  min-height: 0;
}

.vh-docs-panel {
  display: flex;
  width: var(--vh-panel-width);
  min-width: 0;
  min-height: 0;
  flex: 0 1 auto;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}

/* Without the rail, the panel takes the whole sidebar width. */
.vh-docs-panel.is-single {
  width: auto;
  flex: 1 1 auto;
}

.dark .vh-docs-panel {
  background: var(--ui-bg);
}
</style>
