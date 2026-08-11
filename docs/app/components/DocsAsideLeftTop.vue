<script setup lang="ts">
const { lane, laneOptions, selectLane } = useDocsLane();
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
      <button
        v-for="(option, index) in laneOptions"
        :key="option.id"
        type="button"
        :class="['vh-docs-lane-option w-max lg:w-auto', {
          'is-active': lane === option.id,
          'is-before-active': lane === laneOptions[index + 1]?.id,
          'is-after-active': lane === laneOptions[index - 1]?.id,
        }]"
        :aria-pressed="lane === option.id"
        @click="selectLane(option.id)"
      >
        <UIcon :name="option.icon" class="size-4 shrink-0" />
        <span>{{ option.label }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.vh-docs-lane-switcher {
  display: flex;
}

.vh-docs-lane-switcher::after {
  content: "";
  flex: 1;
  border-bottom: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
}

.vh-docs-lane-option {
  display: flex;
  min-width: 0;
  min-height: 2.5rem;
  align-items: center;
  justify-content: flex-start;
  gap: 0.375rem;
  padding: 0.5rem 1.25rem;
  border: 0;
  border-radius: 0;
  background: var(--ui-bg-muted);
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1rem;
  opacity: 0.68;
  text-align: center;
  transition: background-color 150ms ease, color 150ms ease, opacity 150ms ease, transform 150ms ease;
}

.vh-docs-lane-option:not(.is-active) {
  border-bottom: 1px solid var(--ui-border-accented);
}

.vh-docs-lane-option.is-before-active {
  border-right: 1px solid var(--ui-border-accented);
}

.vh-docs-lane-option.is-after-active {
  border-left: 1px solid var(--ui-border-accented);
}

.vh-docs-lane-option:hover,
.vh-docs-lane-option:focus-visible {
  opacity: 1;
  color: var(--ui-text-highlighted);
}

.vh-docs-lane-option.is-active {
  border: 0;
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  font-weight: 650;
  opacity: 0.82;
}

.vh-docs-lane-option.is-active:hover,
.vh-docs-lane-option.is-active:focus-visible {
  opacity: 1;
}

.vh-docs-lane-option:last-child {
  border-right: 1px solid var(--ui-border-accented);
}

.vh-docs-lane-option:active {
  transform: scale(0.98);
}

.vh-sidebar-search {
  height: 2.5rem;
  font-size: 0.875rem;
}

@media (min-width: 64rem) {
  .vh-docs-lane-switcher {
    display: grid;
    grid-template-columns: 0.8fr 1.2fr;
  }

  .vh-docs-lane-switcher::after {
    display: none;
  }

  .vh-docs-lane-option {
    justify-content: center;
    padding: 0.5rem;
  }

  .vh-docs-lane-option:last-child {
    border-right: 0;
  }
}
</style>
