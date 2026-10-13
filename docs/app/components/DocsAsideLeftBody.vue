<script setup lang="ts">
import { PrimitiveIcon } from "@vite-hub/ui/primitive-rail";
import {
  docsManifest,
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
const pageGroups = computed(() => section.value ? getDocsSidebarGroups(section.value) : []);
const platformSections = docsManifest.sections.filter(candidate => candidate.category === "Platform");
const related = computed(() =>
  section.value ? getDocsRelatedSections(docsManifest.sections, section.value) : [],
);
// Outside every section, for example on the catalog in the mobile menu, the panel lists every product by category.
const catalog = getDocsCatalog(docsManifest.sections);

function isActive(path: string) {
  return currentPath.value === normalizeDocsPath(path);
}
</script>

<template>
  <nav v-if="section" class="vh-docs-sidebar-nav" :aria-label="`${section.title} pages`">
    <template v-for="(pageGroup, groupIndex) in pageGroups" :key="groupIndex">
      <section v-if="pageGroup.label" class="vh-docs-sidebar-page-group">
        <h2 class="vh-docs-sidebar-page-group-heading">{{ pageGroup.label }}</h2>
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
      <h2 v-if="related.length > 1" class="vh-docs-sidebar-heading">Related</h2>
      <NuxtLink
        v-for="relatedSection in related"
        :key="relatedSection.id"
        :to="relatedSection.path"
        class="vh-docs-sidebar-link"
      >
        <PrimitiveIcon :name="railSectionIcon(relatedSection)" class="vh-docs-sidebar-icon" />
        <span class="min-w-0 truncate">{{ relatedSection.title }}</span>
      </NuxtLink>
    </section>

    <section v-if="section.id === 'getting-started' || section.category === 'Platform'" class="vh-docs-sidebar-related" aria-label="Build and deploy">
      <h2 class="vh-docs-sidebar-heading">Build and deploy</h2>
      <NuxtLink
        v-for="platformSection in platformSections"
        :key="platformSection.id"
        :to="platformSection.path"
        class="vh-docs-sidebar-link"
      >
        <UIcon :name="sidebarSectionIcon(platformSection)" class="size-4 shrink-0" />
        <span class="min-w-0 truncate">{{ platformSection.title }}</span>
      </NuxtLink>
    </section>

    <NuxtLink v-if="section.id !== 'getting-started'" to="/docs/getting-started" class="vh-docs-sidebar-link vh-docs-sidebar-catalog-link">
      <UIcon name="i-lucide-book-open" class="size-4 shrink-0" />
      <span class="min-w-0 truncate">Get started</span>
    </NuxtLink>

    <NuxtLink to="/docs" class="vh-docs-sidebar-link vh-docs-sidebar-catalog-link">
      <UIcon name="i-ph-squares-four-light" class="size-4 shrink-0" />
      <span class="min-w-0 truncate">Browse all docs</span>
    </NuxtLink>
  </nav>

  <nav v-else class="vh-docs-sidebar-nav" aria-label="All products">
    <section v-for="group in catalog" :key="group.category" class="vh-docs-sidebar-category">
      <h2 class="vh-docs-sidebar-heading">{{ group.category === "Start" ? "Get started" : group.category }}</h2>
      <NuxtLink
        v-for="catalogSection in group.sections"
        :key="catalogSection.id"
        :to="catalogSection.path"
        class="vh-docs-sidebar-link"
      >
        <PrimitiveIcon :name="railSectionIcon(catalogSection)" class="vh-docs-sidebar-icon" />
        <span class="min-w-0 truncate">{{ catalogSection.title }}</span>
      </NuxtLink>
    </section>
  </nav>
</template>

<style scoped>
/* Rows match the Console context panel and the rail: inset tiles 0.125rem apart, no rules between groups. */
.vh-docs-sidebar-nav {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 0.125rem;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 0.5rem 1rem;
}

.vh-docs-sidebar-page-group,
.vh-docs-sidebar-category,
.vh-docs-sidebar-related {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.vh-docs-sidebar-page-group-heading,
.vh-docs-sidebar-heading {
  margin: 0;
  padding: 0.75rem 0.5rem 0.25rem;
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 500;
}

.vh-docs-sidebar-link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2rem;
  border-radius: 0.375rem;
  padding: 0.25rem 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  transition:
    background-color 150ms ease,
    color 150ms ease;
}

.vh-docs-sidebar-link:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
  color: var(--ui-text-highlighted);
}

.vh-docs-sidebar-link.is-active {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

@media (hover: hover) {
  .vh-docs-sidebar-link:hover {
    background: var(--ui-bg-elevated);
    color: var(--ui-text-highlighted);
  }

  .vh-docs-sidebar-link.is-active:hover {
    background: var(--ui-bg-accented);
  }
}

.vh-docs-sidebar-icon {
  width: 1rem;
  height: 1rem;
}

@media (pointer: coarse) {
  .vh-docs-sidebar-link {
    min-height: 2.5rem;
  }
}
</style>
