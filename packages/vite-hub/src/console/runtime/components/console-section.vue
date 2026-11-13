<script setup lang="ts">
import { computed, useId, useTemplateRef } from "vue";

/**
 * A titled section inside a Console page or detail panel, such as "Sessions" in a user or "Breakdown" in Usage. Every
 * section heading in the Console is this component, so headings have one size, weight, and color: 14px medium in
 * `text-highlighted`, with an optional count badge, a one-line description, and actions on the right. A page title is
 * ConsolePageHeader, not a section.
 *
 * `level` keeps the outline right: 2 under a page title, 3 under a panel title such as a slideover's.
 * We chose a component over a class convention because the heading row (title, count, description, and actions) was
 * written out in many different ways, not only its classes.
 */
const props = withDefaults(
  defineProps<{
    count?: number | string;
    description?: string;
    /** Lets code move focus to the heading with `focus()`, such as after a page change. */
    focusable?: boolean;
    /** The id of the heading, for a link or a test that finds it. Defaults to a generated one. */
    headingId?: string;
    level?: 2 | 3 | 4;
    title: string;
  }>(),
  { count: undefined, description: undefined, focusable: false, headingId: undefined, level: 2 },
);
defineSlots<{
  actions?: () => unknown;
  default?: () => unknown;
  /** Extra text after the title, such as a period ("30 days"). */
  title?: () => unknown;
}>();
const generatedId = useId();
const id = computed(() => props.headingId ?? generatedId);
const heading = useTemplateRef<HTMLElement>("heading");
defineExpose({
  /** Scrolls the section to the top and moves focus to its heading. Needs `focusable`. */
  focus(): void {
    heading.value?.scrollIntoView({ block: "start" });
    heading.value?.focus({ preventScroll: true });
  },
});
</script>

<template>
  <section class="grid min-w-0 content-start gap-3" :aria-labelledby="id">
    <div class="flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div class="min-w-0">
        <component
          :is="`h${props.level}`"
          :id="id"
          ref="heading"
          :tabindex="focusable ? -1 : undefined"
          class="flex min-w-0 scroll-mt-4 items-center gap-2 text-sm font-medium text-highlighted"
        >
          <span class="min-w-0 break-words">{{ title }}</span>
          <UBadge v-if="count !== undefined" :label="String(count)" class="tabular-nums" />
          <slot name="title" />
        </component>
        <p v-if="description" class="mt-0.5 text-xs text-pretty text-muted">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-1">
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </section>
</template>
