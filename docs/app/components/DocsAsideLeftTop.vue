<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionForPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const currentSection = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
const sectionPath = computed(() => currentSection.value?.path || "/docs");
const sectionTitle = computed(() => currentSection.value?.title || "All products");
const sectionCategory = computed(() => {
  const category = currentSection.value?.category;
  return category && category !== currentSection.value?.title ? category : "Getting started";
});
const isDocsIndex = computed(() => normalizeDocsPath(route.path) === "/docs");
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

    <NuxtLink
      :to="sectionPath"
      class="vh-docs-context"
      :class="{ 'is-current': isDocsIndex }"
      :aria-current="isDocsIndex ? 'page' : undefined"
    >
      <UIcon
        :name="currentSection ? sidebarSectionIcon(currentSection) : 'i-ph-squares-four-light'"
        class="size-4 shrink-0 text-muted"
      />
      <span class="vh-docs-context-copy">
        <span class="vh-docs-context-category">{{ sectionCategory }}</span>
        <span class="vh-docs-context-title">{{ sectionTitle }}</span>
      </span>
      <UIcon name="i-lucide-arrow-up-right" class="vh-docs-context-arrow size-3.5 shrink-0" aria-hidden="true" />
    </NuxtLink>
  </div>
</template>

<style scoped>
.vh-sidebar-search {
  height: 2.5rem;
  font-size: 0.875rem;
}

.vh-docs-context {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-height: 3.25rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0.5rem 1.25rem;
  color: var(--ui-text-muted);
  transition: background-color 150ms ease, color 150ms ease;
}

.vh-docs-context:hover,
.vh-docs-context:focus-visible,
.vh-docs-context.is-current {
  background: color-mix(in srgb, var(--ui-text-highlighted) 5%, transparent);
  color: var(--ui-text-highlighted);
}

.vh-docs-context-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 0.125rem;
}

.vh-docs-context-category {
  color: var(--ui-text-dimmed);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.07em;
  line-height: 1;
  text-transform: uppercase;
}

.vh-docs-context-title {
  overflow: hidden;
  color: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vh-docs-context-arrow {
  color: var(--ui-text-dimmed);
  transition: transform 150ms ease, color 150ms ease;
}

.vh-docs-context:hover .vh-docs-context-arrow,
.vh-docs-context:focus-visible .vh-docs-context-arrow {
  color: var(--ui-text-highlighted);
  transform: translate(1px, -1px);
}
</style>
