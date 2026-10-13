<script setup lang="ts">
import {
  docsManifest,
  getDocsPageByPath,
  normalizeDocsPath,
} from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  getDocsCatalog,
  getDocsRelatedSections,
  getDocsSectionForPath,
  getDocsSidebarGroups,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const currentPath = computed(() => normalizeDocsPath(route.path));
const section = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
const pageGroups = computed(() => {
  if (!section.value) return [];
  const groups = getDocsSidebarGroups(section.value);
  const perspective = getDocsPageByPath("/docs/getting-started/built-for-vue");
  if (section.value.id !== "ui" || !perspective) return groups;
  return groups.map((group) =>
    group.label === "Start" ? { ...group, pages: [...group.pages, perspective] } : group,
  );
});
const related = computed(() =>
  section.value ? getDocsRelatedSections(docsManifest.sections, section.value) : [],
);
// Outside every section, for example on the catalog, the sidebar lists every product by category.
const catalog = getDocsCatalog(docsManifest.sections);

function isActive(path: string) {
  return currentPath.value === normalizeDocsPath(path);
}
</script>

<template>
  <nav v-if="section" class="vh-docs-sidebar-nav" :aria-label="`${section.title} pages`">
    <template v-for="pageGroup in pageGroups" :key="pageGroup.label || 'pages'">
      <section v-if="pageGroup.label" class="vh-docs-sidebar-page-group">
        <h2 class="vh-docs-sidebar-page-group-heading">{{ pageGroup.label }}</h2>
        <NuxtLink
          v-for="page in pageGroup.pages"
          :key="page.path"
          :to="page.path"
          :class="['vh-docs-sidebar-link is-grouped', { 'is-active': isActive(page.path) }]"
          :aria-current="isActive(page.path) ? 'page' : undefined"
        >
          <UIcon :name="sidebarPageIcon(page)" class="size-4 shrink-0" />
          <span class="min-w-0 truncate">{{ page.title }}</span>
        </NuxtLink>
      </section>

      <template v-else>
        <NuxtLink
          v-for="page in pageGroup.pages"
          :key="page.path"
          :to="page.path"
          :class="['vh-docs-sidebar-link', { 'is-active': isActive(page.path) }]"
          :aria-current="isActive(page.path) ? 'page' : undefined"
        >
          <UIcon :name="sidebarPageIcon(page)" class="size-4 shrink-0" />
          <span class="min-w-0 truncate">{{ page.title }}</span>
        </NuxtLink>
      </template>
    </template>

    <section v-if="related.length" class="vh-docs-sidebar-related" aria-label="Related products">
      <h2 class="vh-docs-sidebar-heading">Related</h2>
      <NuxtLink
        v-for="relatedSection in related"
        :key="relatedSection.id"
        :to="relatedSection.path"
        class="vh-docs-sidebar-link"
      >
        <UIcon :name="sidebarSectionIcon(relatedSection)" class="size-4 shrink-0" />
        <span class="min-w-0 truncate">{{ relatedSection.title }}</span>
      </NuxtLink>
    </section>

    <NuxtLink to="/docs" class="vh-docs-sidebar-link vh-docs-sidebar-catalog-link">
      <UIcon name="i-ph-squares-four-light" class="size-4 shrink-0" />
      <span class="min-w-0 truncate">Browse all docs</span>
    </NuxtLink>
  </nav>

  <nav v-else class="vh-docs-sidebar-nav" aria-label="All products">
    <section v-for="group in catalog" :key="group.category" class="vh-docs-sidebar-category">
      <h2 class="vh-docs-sidebar-heading">{{ group.category }}</h2>
      <NuxtLink
        v-for="catalogSection in group.sections"
        :key="catalogSection.id"
        :to="catalogSection.path"
        class="vh-docs-sidebar-link"
      >
        <UIcon :name="sidebarSectionIcon(catalogSection)" class="size-4 shrink-0" />
        <span class="min-w-0 truncate">{{ catalogSection.title }}</span>
      </NuxtLink>
    </section>
  </nav>
</template>

<style scoped>
.vh-docs-sidebar-nav {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0.5rem 0 1rem;
}

.vh-docs-sidebar-page-group,
.vh-docs-sidebar-category {
  border-top: 1px solid color-mix(in srgb, var(--ui-border) 65%, transparent);
}

.vh-docs-sidebar-page-group:first-child,
.vh-docs-sidebar-category:first-child {
  border-top: 0;
}

.vh-docs-sidebar-category {
  padding-bottom: 0.25rem;
}

.vh-docs-sidebar-page-group-heading,
.vh-docs-sidebar-heading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem 1.25rem 0.375rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-docs-sidebar-link {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  border-left: 2px solid transparent;
  padding: 0.25rem 1.25rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  transition:
    border-color 150ms ease,
    background-color 150ms ease,
    color 150ms ease;
}

.vh-docs-sidebar-link.is-grouped {
  padding-left: 2rem;
}

.vh-docs-sidebar-link:hover,
.vh-docs-sidebar-link:focus-visible,
.vh-docs-sidebar-link.is-active {
  border-left-color: var(--ui-text-highlighted);
  background: color-mix(in srgb, var(--ui-text-highlighted) 6%, transparent);
  color: var(--ui-text);
}

.vh-docs-sidebar-related {
  margin-top: 0.75rem;
  border-top: 1px solid var(--ui-border);
  padding-bottom: 0.25rem;
}

.vh-docs-sidebar-catalog-link {
  margin-top: 0.5rem;
  border-top: 1px solid var(--ui-border);
  padding-top: 0.625rem;
  padding-bottom: 0.625rem;
  color: var(--ui-text-dimmed);
  font-size: 0.8125rem;
}
</style>
