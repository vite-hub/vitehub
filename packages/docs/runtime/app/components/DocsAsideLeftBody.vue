<script setup lang="ts">
import type { DocsAppPage, DocsSidebarGroup } from "@vite-hub/docs"

import { docsCatalog, docsHasRail, docsPanelOf, docsPanelSidebarGroups, docsRelatedSections, docsSectionHome, docsSectionPanels, docsSidebarGroup, docsSidebarGroups, docsSidebarSections, normalizeDocsPath } from "#docs/navigation"

const route = useRoute()
const manifest = useDocsManifest()
const { categories, groups, icons: iconOptions, railExclude, start } = useDocsConfig()
const icons = useDocsIcons()
const currentPath = computed(() => normalizeDocsPath(route.path))
const section = useDocsSection()
// The start section is the home of the docs, so it also lists the site pages that the header shows on the landing page.
const startLinks = computed(() => section.value && section.value.id === start?.section ? start.links : [])
const pageGroups = computed(() => section.value ? docsSidebarGroups(section.value) : [])
const related = computed(() => section.value ? docsRelatedSections(manifest, section.value) : [])
// Outside every section, for example on the catalog, the sidebar lists every section by category.
const catalog = docsCatalog(manifest, categories)
// A small site has no rail, so the sidebar lists every section with its pages on every page.
const rail = docsHasRail(manifest, iconOptions, groups, { categories, railExclude })
// Sidebar membership comes from every manifest section, including groups entirely excluded from the rail.
const group = computed(() => section.value ? docsSidebarGroup(manifest, section.value, groups) : null)
const sectionBlocks = computed(() => {
  const sections = rail ? group.value?.sections : manifest.sections
  return sections ? docsSidebarSections(sections) : null
})
const groupStartLinks = computed(() => start && group.value?.sections.some(candidate => candidate.id === start.section) ? start.links : [])
// Nuxt serializes a `null` runtime config value as "", so `start` can be a string here.
const siteLinks = computed(() => rail ? groupStartLinks.value : start?.links ?? [])

// A folder with `navigation.panel: true` replaces the section sidebar while the reader is inside it. The section sidebar
// links to each panel once.
const panel = computed(() => {
  const page = section.value?.pages.find(candidate => candidate.path === currentPath.value)
  return section.value && page ? docsPanelOf(section.value, page) : null
})
const panels = computed(() => section.value ? docsSectionPanels(section.value) : [])
// The site search finds a page of a long panel, so the panel has no filter of its own.
const panelGroups = computed(() => panel.value && section.value ? docsPanelSidebarGroups(section.value, panel.value) : [])

function isActive(path: string) {
  return currentPath.value === normalizeDocsPath(path)
}

// A folded group opens itself on its own pages, so the current page stays in view.
// Key the active disclosure by its page so navigation also reopens a group the reader closed.
// Panels often list codes such as `QUEUE_BINDING_NOT_FOUND`. A code reads as code on one line, and the tooltip holds a
// code that the sidebar cuts.
function isCode(title: string) {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(title)
}

function holdsCurrent(pageGroup: DocsSidebarGroup<DocsAppPage>) {
  return pageGroup.pages.some(page => isActive(page.path))
}
</script>

<template>
  <nav v-if="panel && section" class="vh-docs-sidebar-nav" :aria-label="`${panel.title} pages`">
    <section class="vh-docs-sidebar-page-group vh-docs-sidebar-site-areas" :aria-label="`${panel.title} overview`">
      <NuxtLink data-focus-inset :to="docsSectionHome(section)" class="vh-docs-sidebar-link vh-docs-sidebar-back">
        <UIcon name="i-lucide-arrow-left" class="size-4 shrink-0" />
        <span class="min-w-0">{{ section.title }}</span>
      </NuxtLink>
      <NuxtLink
        :to="panel.path"
        data-focus-inset
        :class="['vh-docs-sidebar-link', { 'is-active': isActive(panel.path) }]"
        :aria-current="isActive(panel.path) ? 'page' : undefined"
      >
        <UIcon :name="icons.page(panel)" class="size-4 shrink-0" />
        <span class="min-w-0">{{ panel.title }}</span>
      </NuxtLink>
    </section>

    <template v-for="pageGroup in panelGroups" :key="pageGroup.label || 'pages'">
      <details
        v-if="pageGroup.fold"
        :key="holdsCurrent(pageGroup) ? currentPath : undefined"
        class="vh-docs-sidebar-page-group vh-docs-sidebar-fold"
        :open="holdsCurrent(pageGroup)"
      >
        <summary data-focus-inset class="vh-docs-sidebar-page-group-heading">
          <UIcon name="i-lucide-chevron-down" class="vh-docs-sidebar-fold-icon size-3 shrink-0" />
          {{ pageGroup.label }}
          <span class="vh-docs-sidebar-count">{{ pageGroup.pages.length }}</span>
        </summary>
        <NuxtLink
          v-for="page in pageGroup.pages"
          :key="page.path"
          :to="page.path"
          data-focus-inset
          :class="['vh-docs-sidebar-link is-grouped', { 'is-active': isActive(page.path) }]"
          :aria-current="isActive(page.path) ? 'page' : undefined"
        >
          <span :class="['min-w-0', { 'vh-docs-sidebar-code': isCode(page.title) }]" :title="isCode(page.title) ? page.title : undefined">{{ page.title }}</span>
        </NuxtLink>
      </details>
      <section v-else class="vh-docs-sidebar-page-group">
        <h2 v-if="pageGroup.label" class="vh-docs-sidebar-page-group-heading">{{ pageGroup.label }}</h2>
        <NuxtLink
          v-for="page in pageGroup.pages"
          :key="page.path"
          :to="page.path"
          data-focus-inset
          :class="['vh-docs-sidebar-link', { 'is-grouped': pageGroup.label, 'is-active': isActive(page.path) }]"
          :aria-current="isActive(page.path) ? 'page' : undefined"
        >
          <span :class="['min-w-0', { 'vh-docs-sidebar-code': isCode(page.title) }]" :title="isCode(page.title) ? page.title : undefined">{{ page.title }}</span>
        </NuxtLink>
      </section>
    </template>
  </nav>

  <nav v-else-if="sectionBlocks" class="vh-docs-sidebar-nav" :aria-label="rail ? `${group?.title} pages` : 'Docs pages'">
    <section v-if="siteLinks.length" class="vh-docs-sidebar-page-group vh-docs-sidebar-site-areas" aria-label="Site areas">
      <NuxtLink
        v-for="link in siteLinks"
        :key="link.to"
        :to="link.to"
        data-focus-inset
        :class="['vh-docs-sidebar-link', { 'is-active': isActive(link.to) }]"
        :aria-current="isActive(link.to) ? 'page' : undefined"
      >
        <UIcon :name="link.icon ?? icons.page({ path: link.to, icon: null })" class="size-4 shrink-0" />
        <span class="min-w-0">{{ link.label }}</span>
      </NuxtLink>
    </section>
    <!-- A section is one row that opens its home page. Its other pages follow it, indented to its title. -->
    <section
      v-for="(block, index) in sectionBlocks"
      :key="`${index}:${block.category}`"
      class="vh-docs-sidebar-category"
      :aria-label="block.category ?? undefined"
    >
      <h2 v-if="block.category" class="vh-docs-sidebar-heading">{{ block.category }}</h2>
      <template v-for="entry in block.sections" :key="entry.section.id">
        <NuxtLink
          v-if="entry.home"
          :to="entry.home.path"
          data-focus-inset
          :class="['vh-docs-sidebar-link', { 'is-active': isActive(entry.home.path) }]"
          :aria-current="isActive(entry.home.path) ? 'page' : undefined"
        >
          <UIcon :name="icons.section(entry.section)" class="size-4 shrink-0" />
          <span class="min-w-0">{{ entry.section.title }}</span>
        </NuxtLink>
        <h3 v-else class="vh-docs-sidebar-section-title">
          <UIcon :name="icons.section(entry.section)" class="size-4 shrink-0" />
          <span class="min-w-0">{{ entry.section.title }}</span>
        </h3>
        <template v-for="pageGroup in entry.groups" :key="pageGroup.label || 'pages'">
          <details
            v-if="pageGroup.fold"
            :key="holdsCurrent(pageGroup) ? currentPath : undefined"
            class="vh-docs-sidebar-fold"
            :open="holdsCurrent(pageGroup)"
          >
            <summary data-focus-inset class="vh-docs-sidebar-page-group-heading is-nested">
              <UIcon name="i-lucide-chevron-down" class="vh-docs-sidebar-fold-icon size-3 shrink-0" />
              {{ pageGroup.label }}
            </summary>
            <NuxtLink
              v-for="page in pageGroup.pages"
              :key="page.path"
              :to="page.path"
              data-focus-inset
              :class="['vh-docs-sidebar-link is-nested', { 'is-active': isActive(page.path) }]"
              :aria-current="isActive(page.path) ? 'page' : undefined"
            >
              <UIcon :name="icons.page(page)" class="size-4 shrink-0" />
              <span class="min-w-0">{{ page.title }}</span>
            </NuxtLink>
          </details>
          <template v-else>
            <h4 v-if="pageGroup.label" class="vh-docs-sidebar-page-group-heading is-nested">{{ pageGroup.label }}</h4>
            <NuxtLink
              v-for="page in pageGroup.pages"
              :key="page.path"
              :to="page.path"
              data-focus-inset
              :class="['vh-docs-sidebar-link is-nested', { 'is-active': isActive(page.path) }]"
              :aria-current="isActive(page.path) ? 'page' : undefined"
            >
              <UIcon :name="icons.page(page)" class="size-4 shrink-0" />
              <span class="min-w-0">{{ page.title }}</span>
            </NuxtLink>
          </template>
        </template>
        <NuxtLink
          v-for="entryPanel in docsSectionPanels(entry.section)"
          :key="entryPanel.page.path"
          :to="entryPanel.page.path"
          data-focus-inset
          class="vh-docs-sidebar-link vh-docs-sidebar-panel-link is-nested"
        >
          <span class="min-w-0">{{ entryPanel.page.title }}</span>
          <span class="vh-docs-sidebar-count">{{ entryPanel.count }}</span>
          <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0" />
        </NuxtLink>
      </template>
    </section>

    <section v-if="rail && related.length" class="vh-docs-sidebar-related" aria-label="Related products">
      <h2 class="vh-docs-sidebar-heading">Related</h2>
      <NuxtLink
        v-for="relatedSection in related"
        :key="relatedSection.id"
        :to="docsSectionHome(relatedSection)"
        data-focus-inset
        class="vh-docs-sidebar-link"
      >
        <UIcon :name="icons.section(relatedSection)" class="size-4 shrink-0" />
        <span class="min-w-0">{{ relatedSection.title }}</span>
      </NuxtLink>
    </section>
  </nav>

  <nav v-else-if="section" class="vh-docs-sidebar-nav" :aria-label="`${section.title} pages`">
    <section v-if="startLinks.length" class="vh-docs-sidebar-page-group vh-docs-sidebar-site-areas" aria-label="Site areas">
      <NuxtLink
        v-for="link in startLinks"
        :key="link.to"
        :to="link.to"
        data-focus-inset
        :class="['vh-docs-sidebar-link', { 'is-active': isActive(link.to) }]"
        :aria-current="isActive(link.to) ? 'page' : undefined"
      >
        <UIcon :name="link.icon ?? icons.page({ path: link.to, icon: null })" class="size-4 shrink-0" />
        <span class="min-w-0">{{ link.label }}</span>
      </NuxtLink>
    </section>

    <template v-for="pageGroup in pageGroups" :key="pageGroup.label || 'pages'">
      <details
        v-if="pageGroup.fold"
        :key="holdsCurrent(pageGroup) ? currentPath : undefined"
        class="vh-docs-sidebar-page-group vh-docs-sidebar-fold"
        :open="holdsCurrent(pageGroup)"
      >
        <summary data-focus-inset class="vh-docs-sidebar-page-group-heading">
          <UIcon name="i-lucide-chevron-down" class="vh-docs-sidebar-fold-icon size-3 shrink-0" />
          {{ pageGroup.label }}
        </summary>
        <NuxtLink
          v-for="page in pageGroup.pages"
          :key="page.path"
          :to="page.path"
          data-focus-inset
          :class="['vh-docs-sidebar-link is-grouped', { 'is-active': isActive(page.path) }]"
          :aria-current="isActive(page.path) ? 'page' : undefined"
        >
          <UIcon :name="icons.page(page)" class="size-4 shrink-0" />
          <span class="min-w-0">{{ page.title }}</span>
        </NuxtLink>
      </details>

      <section v-else-if="pageGroup.label" class="vh-docs-sidebar-page-group">
        <h2 class="vh-docs-sidebar-page-group-heading">{{ pageGroup.label }}</h2>
        <NuxtLink
          v-for="page in pageGroup.pages"
          :key="page.path"
          :to="page.path"
          data-focus-inset
          :class="['vh-docs-sidebar-link is-grouped', { 'is-active': isActive(page.path) }]"
          :aria-current="isActive(page.path) ? 'page' : undefined"
        >
          <UIcon :name="icons.page(page)" class="size-4 shrink-0" />
          <span class="min-w-0">{{ page.title }}</span>
        </NuxtLink>
      </section>

      <template v-else>
        <NuxtLink
          v-for="page in pageGroup.pages"
          :key="page.path"
          :to="page.path"
          data-focus-inset
          :class="['vh-docs-sidebar-link', { 'is-active': isActive(page.path) }]"
          :aria-current="isActive(page.path) ? 'page' : undefined"
        >
          <UIcon :name="icons.page(page)" class="size-4 shrink-0" />
          <span class="min-w-0">{{ page.title }}</span>
        </NuxtLink>
      </template>
    </template>

    <!-- A panel is one more row of the page list, with its page count and a chevron for the sidebar it opens. -->
    <NuxtLink
      v-for="entry in panels"
      :key="entry.page.path"
      :to="entry.page.path"
      data-focus-inset
      class="vh-docs-sidebar-link vh-docs-sidebar-panel-link"
    >
      <UIcon :name="icons.page(entry.page)" class="size-4 shrink-0" />
      <span class="min-w-0">{{ entry.page.title }}</span>
      <span class="vh-docs-sidebar-count">{{ entry.count }}</span>
      <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0" />
    </NuxtLink>

    <section v-if="related.length" class="vh-docs-sidebar-related" aria-label="Related products">
      <h2 class="vh-docs-sidebar-heading">Related</h2>
      <NuxtLink
        v-for="relatedSection in related"
        :key="relatedSection.id"
        :to="docsSectionHome(relatedSection)"
        data-focus-inset
        class="vh-docs-sidebar-link"
      >
        <UIcon :name="icons.section(relatedSection)" class="size-4 shrink-0" />
        <span class="min-w-0">{{ relatedSection.title }}</span>
      </NuxtLink>
    </section>

  </nav>

  <nav v-else class="vh-docs-sidebar-nav" aria-label="All products">
    <section v-for="group in catalog" :key="group.category" class="vh-docs-sidebar-category">
      <h2 class="vh-docs-sidebar-heading">{{ group.category }}</h2>
      <NuxtLink
        v-for="catalogSection in group.sections"
        :key="catalogSection.id"
        :to="docsSectionHome(catalogSection)"
        data-focus-inset
        class="vh-docs-sidebar-link"
      >
        <UIcon :name="icons.section(catalogSection)" class="size-4 shrink-0" />
        <span class="min-w-0">{{ catalogSection.title }}</span>
      </NuxtLink>
    </section>
  </nav>
</template>

<style scoped>
/* The page list of the old comark-ui site: compact rows, small category headings, and a hairline that ties pages to their section. */
.vh-docs-sidebar-nav {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0.25rem 1rem 2rem;
  font-size: 0.8125rem;
}

.vh-docs-sidebar-page-group,
.vh-docs-sidebar-category,
.vh-docs-sidebar-site-areas {
  display: flex;
  flex-direction: column;
}

.vh-docs-sidebar-site-areas {
  margin-bottom: 0.5rem;
}

.vh-docs-sidebar-page-group-heading,
.vh-docs-sidebar-heading {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 1rem 0 0.25rem;
  color: var(--ui-text-highlighted);
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.5;
}

:is(.vh-docs-sidebar-category, .vh-docs-sidebar-page-group):first-child > :is(.vh-docs-sidebar-heading, .vh-docs-sidebar-page-group-heading):first-child {
  margin-top: 0.25rem;
}

/* A long title wraps instead of being cut off. The icon stays on its first line. */
.vh-docs-sidebar-link {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0 -0.5rem;
  border-radius: calc(var(--ui-radius) * 1.5);
  padding: 0.3rem 0.5rem;
  color: var(--ui-text-muted);
  line-height: 1.25rem;
  transition:
    background-color 150ms ease,
    box-shadow 150ms ease,
    color 150ms ease;
}

/* Icons stay small and quiet, so the text leads, and take the row's color when it is hovered or current. */
.vh-docs-sidebar-link > .iconify,
.vh-docs-sidebar-section-title > .iconify {
  width: 0.875rem;
  height: 0.875rem;
  margin-top: 0.1875rem;
  color: var(--ui-text-dimmed);
  transition: color 150ms ease;
}

.vh-docs-sidebar-link:is(:hover, .is-active) > .iconify {
  color: currentcolor;
}

/* Touch devices keep 44px tap targets at every viewport width. */
@media (pointer: coarse) {
  .vh-docs-sidebar-link,
  .vh-docs-sidebar-fold > summary {
    min-height: 2.75rem;
    align-items: center;
  }

  .vh-docs-sidebar-link > .iconify {
    margin-top: 0;
  }
}

/* A section's other pages hang from a hairline under its title. The current page darkens its piece of the line. */
.vh-docs-sidebar-link.is-nested,
.vh-docs-sidebar-link.is-grouped {
  margin-left: 0.25rem;
  border-radius: 0 calc(var(--ui-radius) * 1.5) calc(var(--ui-radius) * 1.5) 0;
  padding-left: 0.875rem;
  box-shadow: inset 1px 0 0 var(--ui-border);
}

.vh-docs-sidebar-page-group-heading.is-nested {
  margin-top: 0.5rem;
  padding-left: 0.75rem;
  color: var(--ui-text-muted);
}

/* A folded group: the summary is its heading, and its chevron points right while the group is shut. */
.vh-docs-sidebar-fold > summary {
  cursor: pointer;
  list-style: none;
}

.vh-docs-sidebar-fold > summary::-webkit-details-marker {
  display: none;
}

.vh-docs-sidebar-fold-icon {
  color: var(--ui-text-dimmed);
  transition: transform 150ms ease;
}

.vh-docs-sidebar-fold:not([open]) .vh-docs-sidebar-fold-icon {
  transform: rotate(-90deg);
}

.vh-docs-sidebar-fold:not([open]) > summary {
  color: var(--ui-text-muted);
}

@media (hover: hover) {
  .vh-docs-sidebar-fold > summary:hover {
    color: var(--ui-text-highlighted);
  }
}

@media (prefers-reduced-motion: reduce) {
  .vh-docs-sidebar-fold-icon {
    transition: none;
  }
}

/* A section without a listed home page has a title row that opens nothing. */
.vh-docs-sidebar-section-title {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
  padding: 0.3rem 0;
  color: var(--ui-text-highlighted);
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.25rem;
}

/* Hover tints the row and keeps the body text. The current page takes the highlighted text, so a hovered row never looks current. */
@media (hover: hover) {
  .vh-docs-sidebar-link:hover {
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
  }
}

.vh-docs-sidebar-link.is-active {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

.vh-docs-sidebar-link.is-active:is(.is-nested, .is-grouped) {
  box-shadow: inset 1px 0 0 var(--ui-text-highlighted);
}

/* Related sits at the foot of the list. */
.vh-docs-sidebar-related {
  display: flex;
  flex-direction: column;
  margin-top: auto;
  padding-top: 0.75rem;
}

.vh-docs-sidebar-panel-link {
  align-items: center;
}

.vh-docs-sidebar-panel-link > .iconify {
  margin-top: 0;
}

.vh-docs-sidebar-count {
  margin-inline-start: auto;
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  text-transform: none;
}

.vh-docs-sidebar-back {
  color: var(--ui-text-dimmed);
}

.vh-docs-sidebar-code {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
