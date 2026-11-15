<script setup lang="ts">
import { consoleSidebarOpen, toggleConsoleSidebar } from "../client/sidebar";

/** The button at the start of the page header that opens and closes the sidebar, as in shadcn/ui. The `[` key does too. */
</script>

<template>
  <UTooltip :text="consoleSidebarOpen ? 'Close sidebar' : 'Open sidebar'" :kbds="['[']">
    <UButton
      color="neutral"
      variant="ghost"
      icon="i-lucide-panel-left"
      class="vitehub-sidebar-trigger"
      :aria-label="consoleSidebarOpen ? 'Close sidebar' : 'Open sidebar'"
      :aria-expanded="consoleSidebarOpen"
      @click="toggleConsoleSidebar"
    />
  </UTooltip>
  <span class="vitehub-sidebar-trigger__rule" aria-hidden="true" />
</template>

<style>
.vitehub-sidebar-trigger {
  margin-inline-start: -0.375rem;
}

.vitehub-sidebar-trigger__rule {
  background: var(--ui-border);
  flex: none;
  height: 1rem;
  margin-inline: 0.125rem 0.25rem;
  width: 1px;
}
</style>
