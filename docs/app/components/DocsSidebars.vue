<script setup lang="ts">
defineProps<{
  /** Shows the page panel next to the rail. Outside a section the panel lists every product. */
  panel: boolean;
}>();
</script>

<template>
  <div class="vh-docs-sidebars">
    <DocsRail />
    <div v-if="panel" class="vh-docs-panel">
      <DocsAsideLeftTop />
      <DocsAsideLeftBody />
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

.dark .vh-docs-panel {
  background: #000;
}
</style>
