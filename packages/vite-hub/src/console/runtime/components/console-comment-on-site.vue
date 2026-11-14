<script setup lang="ts">
import { computed } from "vue";

import { commentOnSiteUrl } from "../client/comment-on-site";

/**
 * **Comment on site**: the app's home page in a new tab, in comment mode. With `pages`, such as the pages that have
 * threads, the arrow opens one of them instead. The app decides on the page who may comment.
 */
const props = withDefaults(defineProps<{ pages?: readonly string[], size?: "xs" | "sm" | "md" }>(), { pages: () => [], size: "sm" });

const home = computed(() => commentOnSiteUrl());
const pageItems = computed(() => [...new Set(props.pages)].sort().flatMap((page) => {
  const href = commentOnSiteUrl(page);
  // A menu item with a `to` is a router link on a Console at the app's origin, so it opens the tab itself.
  return href ? [{ label: page, icon: "i-lucide-file", onSelect: () => void window.open(href, "_blank", "noopener") }] : [];
}));
</script>

<template>
  <UFieldGroup>
    <UTooltip text="Opens the site in a new tab with Comments on" :content="{ side: 'bottom' }">
      <UButton :size="size" icon="i-lucide-message-square-plus" label="Comment on site" :href="home" external target="_blank" rel="noopener" />
    </UTooltip>
    <UDropdownMenu v-if="pageItems.length" :items="pageItems" :content="{ align: 'end' }" :ui="{ content: 'max-h-80 max-w-80', itemLabel: 'font-mono text-xs truncate' }">
      <UButton :size="size" icon="i-lucide-chevron-down" aria-label="Comment on another page" class="border-s border-(--ui-bg)/25" />
    </UDropdownMenu>
  </UFieldGroup>
</template>
