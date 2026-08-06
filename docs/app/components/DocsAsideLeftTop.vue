<script setup lang="ts">
const { lane, laneOptions, laneTarget } = useDocsLane();
</script>

<template>
  <div class="vh-sidebar-head">
    <UContentSearchButton
      :collapsed="false"
      class="vh-sidebar-search"
      :ui="{
        base: 'h-10 rounded-none border-0 border-b border-default bg-muted/20 ps-5 pe-5 text-muted hover:bg-muted/40 hover:text-highlighted',
        trailing: 'ms-auto flex items-center gap-1',
      }"
    />

    <nav class="vh-docs-lane-switcher" aria-label="Documentation product">
      <NuxtLink
        v-for="option in laneOptions"
        :key="option.id"
        :to="laneTarget(option.id)"
        :class="['vh-docs-lane-option', { 'is-active': lane === option.id }]"
        :aria-current="lane === option.id ? 'page' : undefined"
      >
        <UIcon :name="option.icon" class="size-4 shrink-0" />
        <span>{{ option.label }}</span>
      </NuxtLink>
    </nav>
  </div>
</template>

<style scoped>
.vh-sidebar-head {
  border-bottom: 1px solid var(--ui-border);
}

.vh-docs-lane-switcher {
  display: grid;
  grid-template-columns: 0.8fr 1.2fr;
  border-bottom: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-bg-muted) 40%, transparent);
}

.vh-docs-lane-option {
  display: flex;
  min-width: 0;
  min-height: 2.5rem;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 550;
  line-height: 1rem;
  text-align: center;
  transition: background-color 150ms ease, color 150ms ease;
}

.vh-docs-lane-option + .vh-docs-lane-option {
  border-left: 1px solid var(--ui-border);
}

.vh-docs-lane-option:hover,
.vh-docs-lane-option:focus-visible {
  color: var(--ui-text-highlighted);
}

.vh-docs-lane-option.is-active {
  background: var(--ui-bg-inverted);
  color: var(--ui-text-inverted);
}

.vh-sidebar-search {
  height: 2.5rem;
  font-size: 0.875rem;
}
</style>
