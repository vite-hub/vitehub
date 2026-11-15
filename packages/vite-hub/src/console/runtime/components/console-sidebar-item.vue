<script setup lang="ts">
import { onMounted, useTemplateRef, watch } from "vue";

import { consoleSidebarOpen } from "../client/sidebar";

/**
 * One row of the Console sidebar: an icon and a label, and a count such as open comments. It renders a link when it has
 * `href`, else a button. On the collapsed rail the label is clipped, not removed, so the icon keeps its place and a
 * tooltip names the row.
 */
const props = defineProps<{
  label: string;
  /** Iconify name. The `icon` slot replaces it, such as with a primitive icon. */
  icon?: string;
  current?: boolean;
  href?: string;
  /** A count after the label. */
  badge?: number | string;
  /** What the count means, for screen readers, such as `open`. */
  badgeLabel?: string;
  shortcut?: readonly string[];
}>();

defineEmits<{ click: [event: MouseEvent] }>();

// A long list can hide the current row below the fold. The list scrolls the least amount that shows it, after a direct
// visit and after each change. Only the list scrolls, never the page.
const row = useTemplateRef<HTMLElement>("row");
function reveal(): void {
  const element = row.value;
  const list = element?.closest(".vitehub-sidebar__scroll");
  if (!props.current || !element || !list) return;
  const item = element.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  if (item.top < box.top) list.scrollTop -= box.top - item.top;
  else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom;
}
onMounted(reveal);
watch(() => props.current, reveal, { flush: "post" });
</script>

<template>
  <UTooltip :text="label" :kbds="shortcut ? [...shortcut] : undefined" :content="{ side: 'right', sideOffset: 10 }" :disabled="consoleSidebarOpen">
    <component
      :is="href ? 'a' : 'button'"
      ref="row"
      :type="href ? undefined : 'button'"
      :href="href"
      class="vitehub-sidebar__item"
      :aria-current="current ? 'page' : undefined"
      @click="$emit('click', $event)"
    >
      <span class="vitehub-sidebar__icon" aria-hidden="true">
        <slot name="icon"><UIcon v-if="icon" :name="icon" /></slot>
      </span>
      <span class="vitehub-sidebar__label">{{ label }}</span>
      <span v-if="badge !== undefined" class="vitehub-sidebar__badge">{{ badge }}<span v-if="badgeLabel" class="sr-only"> {{ badgeLabel }}</span></span>
      <slot name="trailing" />
    </component>
  </UTooltip>
</template>
