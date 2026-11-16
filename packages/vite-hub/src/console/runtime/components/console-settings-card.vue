<script setup lang="ts">
import { useId } from "vue";

/**
 * One setting: a title, a short description, the value or its control, and a footer that says where the value comes
 * from, with the action on the right. A danger card has a red border.
 */
const props = defineProps<{
  title: string;
  description?: string;
  danger?: boolean;
  /** The id of the title, for a page that moves focus to it, such as after a row of the card is removed. */
  headingId?: string;
}>();

// `useId` runs on every render path, so the ids of the other cards stay stable.
const generated = useId();
const id = props.headingId ?? generated;
</script>

<template>
  <section class="vitehub-settings-card" :data-danger="danger ? '' : undefined" :aria-labelledby="id">
    <div class="vitehub-settings-card__body">
      <h2 :id="id" tabindex="-1" class="text-base font-semibold text-highlighted outline-none">{{ title }}</h2>
      <p v-if="description" class="mt-1.5 max-w-150 text-sm text-pretty text-muted">{{ description }}</p>
      <div v-if="$slots.default" class="mt-3.5">
        <slot />
      </div>
    </div>
    <div v-if="$slots.footer || $slots.action" class="vitehub-settings-card__footer">
      <span class="min-w-0 text-pretty"><slot name="footer" /></span>
      <slot name="action" />
    </div>
  </section>
</template>

<style>
.vitehub-settings-card {
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
}

.vitehub-settings-card__body {
  padding: 1.25rem;
}

.vitehub-settings-card__footer {
  align-items: center;
  background: var(--ui-bg-muted);
  border-radius: 0 0 0.5rem 0.5rem;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  display: flex;
  font-size: 0.8125rem;
  gap: 0.75rem;
  justify-content: space-between;
  min-height: 3.25rem;
  padding: 0.625rem 1.25rem;
}

.vitehub-settings-card__footer code {
  color: var(--ui-text-highlighted);
  font-family: var(--font-mono);
  font-size: 0.78125rem;
}

.vitehub-settings-card[data-danger] {
  border-color: color-mix(in oklab, var(--ui-error) 35%, var(--ui-border));
}

.vitehub-settings-card[data-danger] .vitehub-settings-card__footer {
  background: color-mix(in oklab, var(--ui-error) 5%, var(--ui-bg));
  border-top-color: color-mix(in oklab, var(--ui-error) 25%, var(--ui-border));
}
</style>
