<script setup lang="ts">
import type { ContentNavigationItem } from "@nuxt/content";

// Replaces the Docus search so a result shows the page path over its heading.
// The Docus label is one line, "Page > Section > Heading", and a phone cut off the heading.
const props = defineProps<{
  navigation?: ContentNavigationItem[];
}>();

const { forced: forcedColorMode } = useDocusColorMode();
const { search, status: searchStatus, init } = useSearchCollection("docs", { immediate: false, ignoredTags: ["style"] });

const { open } = useContentSearch();
watch(open, (value) => {
  if (value && searchStatus.value === "idle") {
    init();
  }
});

const links = computed(() => props.navigation
  ?.filter((item) => item.children?.length)
  .map((item) => ({ label: item.title, icon: item.icon, to: item.children![0]!.path })));

// Nuxt UI builds the prefix as "Page > Section >".
function searchPath(prefix: string) {
  return prefix.replace(/\s*>$/, "").split(" > ").join(" / ");
}
</script>

<template>
  <LazyUContentSearch
    :search="search"
    :search-status="searchStatus"
    :links="links"
    :navigation="navigation"
    :color-mode="!forcedColorMode"
  >
    <template #item-label="{ item }">
      <span v-if="item.prefix" class="vh-search-path">{{ searchPath(item.prefix) }}</span>
      <span v-if="item.labelHtml" class="vh-search-title" v-html="item.labelHtml" />
      <span v-else class="vh-search-title">{{ item.label }}</span>
    </template>
  </LazyUContentSearch>
</template>
