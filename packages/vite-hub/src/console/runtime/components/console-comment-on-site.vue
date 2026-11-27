<script setup lang="ts">
import { computed } from "vue";

import { commentOnSiteUrl } from "../client/comment-on-site";

const props = withDefaults(defineProps<{ pages?: readonly string[], size?: "xs" | "sm" | "md" }>(), { pages: () => [], size: "sm" });

const home = computed(() => commentOnSiteUrl());
const pageItems = computed(() => [...new Set(props.pages)].sort().flatMap((page) => {
  const href = commentOnSiteUrl(page);
  return href ? [{ label: page, icon: "i-lucide-file", onSelect: () => void window.open(href, "_blank", "noopener") }] : [];
}));
</script>

<template>
  <UFieldGroup>
    <UTooltip text="Opens the site in a new tab with Comments on" :content="{ side: 'bottom' }">
      <UButton :size="size" icon="i-lucide-message-square-plus" label="Comment on site" aria-label="Comment on site" :ui="{ label: 'hidden sm:inline' }" :href="home" external target="_blank" rel="noopener" />
    </UTooltip>
    <UDropdownMenu v-if="pageItems.length" :items="pageItems" :content="{ align: 'end' }" :ui="{ content: 'max-h-80 max-w-80', itemLabel: 'font-mono text-xs truncate' }">
      <UButton :size="size" icon="i-lucide-chevron-down" aria-label="Comment on another page" class="border-s border-(--ui-bg)/25" />
    </UDropdownMenu>
  </UFieldGroup>
</template>
