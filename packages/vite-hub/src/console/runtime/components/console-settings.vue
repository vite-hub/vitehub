<script setup lang="ts">
/**
 * The frame of a settings page: the section menu on the left and the cards of one section on the right. The menu stays
 * mounted while a section loads, so only the values in the cards change.
 */
defineProps<{
  /** The sections of the page, in menu order. `href` is the address of the section, for a new tab. */
  sections: readonly { id: string, label: string, href: string }[];
  current: string;
  label: string;
}>();

const emit = defineEmits<{ select: [id: string] }>();

/** A plain click changes the section in place. A click with a modifier key opens the link as the browser does. */
function follow(event: MouseEvent, id: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  emit("select", id);
}
</script>

<template>
  <div class="vitehub-settings">
    <nav class="vitehub-settings__menu" :aria-label="label">
      <a
        v-for="section in sections"
        :key="section.id"
        :href="section.href"
        class="vitehub-settings__menu-item"
        :aria-current="section.id === current ? 'page' : undefined"
        @click="follow($event, section.id)"
      >{{ section.label }}</a>
    </nav>
    <div class="vitehub-settings__cards">
      <slot />
    </div>
  </div>
</template>

<style>
.vitehub-settings {
  display: grid;
  gap: 2.5rem;
  grid-template-columns: 12.5rem minmax(0, 47.5rem);
  margin-inline: auto;
  max-width: 62.5rem;
}

.vitehub-settings__menu {
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  position: sticky;
  top: 0;
}

.vitehub-settings__menu-item {
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  padding: 0.375rem 0.625rem;
}

.vitehub-settings__menu-item:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

.vitehub-settings__menu-item[aria-current="page"] {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

.vitehub-settings__cards {
  display: grid;
  gap: 1.25rem;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}

/* On a narrow screen the menu is one row above the cards, and it scrolls sideways. */
@media (max-width: 56rem) {
  .vitehub-settings {
    gap: 1.25rem;
    grid-template-columns: minmax(0, 1fr);
  }

  .vitehub-settings__menu {
    flex-direction: row;
    overflow-x: auto;
    position: static;
  }

  .vitehub-settings__menu-item {
    flex-shrink: 0;
  }
}
</style>
