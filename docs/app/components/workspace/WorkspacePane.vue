<script setup lang="ts">
// One pane of a workspace. Every pane has the same header row, so panes side by side line up.
defineProps<{
  /** The accessible name of the pane. */
  label: string
  /** The header text. Use the `header` slot for more. A pane without either has no header, such as the preview, which brings its own bar. */
  title?: string
}>();
</script>

<template>
  <section class="vh-pane" :aria-label="label">
    <div v-if="title || $slots.header" class="vh-pane-header">
      <slot name="header">
        <span class="vh-pane-title">{{ title }}</span>
      </slot>
    </div>
    <div class="vh-pane-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.vh-pane {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.vh-pane-header,
.vh-pane :deep(.vh-ws-preview-bar) {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  height: 2.25rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0 0.75rem;
}

.vh-pane :deep(.vh-ws-preview-bar) {
  padding: 0 0.25rem;
}

.vh-pane-body {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.vh-pane-title {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 500;
}
</style>
