<script setup lang="ts">
import { docsCatalog, docsHasRail, docsRelatedSections, docsSectionGroup, docsSectionHome, docsSidebarGroups, docsSidebarSections, normalizeDocsPath } from "#docs/navigation"

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
const group = computed(() => {
  const title = section.value && docsSectionGroup(section.value, groups)
  if (title === null) return null
  const sections = manifest.sections.filter(candidate => docsSectionGroup(candidate, groups) === title)
  return sections.length > 1 ? { title, sections } : null
})
const sectionBlocks = computed(() => {
  const sections = rail ? group.value?.sections : manifest.sections
  return sections ? docsSidebarSections(sections) : null
})
const groupStartLinks = computed(() => start && group.value?.sections.some(candidate => candidate.id === start.section) ? start.links : [])
// Nuxt serializes a `null` runtime config value as "", so `start` can be a string here.
const siteLinks = computed(() => rail ? groupStartLinks.value : start?.links ?? [])

function isActive(path: string) {
  return currentPath.value === normalizeDocsPath(path)
}
</script>

<template>
  <nav v-if="sectionBlocks" class="vh-docs-sidebar-nav" :aria-label="rail ? `${group?.title} pages` : 'Docs pages'">
    <section v-if="siteLinks.length" class="vh-docs-sidebar-page-group vh-docs-sidebar-site-areas" aria-label="Site areas">
      <NuxtLink
        v-for="link in siteLinks"
        :key="link.to"
        :to="link.to"
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
          <h4 v-if="pageGroup.label" class="vh-docs-sidebar-page-group-heading is-nested">{{ pageGroup.label }}</h4>
          <NuxtLink
            v-for="page in pageGroup.pages"
            :key="page.path"
            :to="page.path"
            :class="['vh-docs-sidebar-link is-nested', { 'is-active': isActive(page.path) }]"
            :aria-current="isActive(page.path) ? 'page' : undefined"
          >
            <span class="min-w-0">{{ page.title }}</span>
          </NuxtLink>
        </template>
      </template>
    </section>

    <section v-if="rail && related.length" class="vh-docs-sidebar-related" aria-label="Related products">
      <h2 class="vh-docs-sidebar-heading">Related</h2>
      <NuxtLink
        v-for="relatedSection in related"
        :key="relatedSection.id"
        :to="docsSectionHome(relatedSection)"
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
        :class="['vh-docs-sidebar-link', { 'is-active': isActive(link.to) }]"
        :aria-current="isActive(link.to) ? 'page' : undefined"
      >
        <UIcon :name="link.icon ?? icons.page({ path: link.to, icon: null })" class="size-4 shrink-0" />
        <span class="min-w-0">{{ link.label }}</span>
      </NuxtLink>
    </section>

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
          <UIcon :name="icons.page(page)" class="size-4 shrink-0" />
          <span class="min-w-0">{{ page.title }}</span>
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
          <UIcon :name="icons.page(page)" class="size-4 shrink-0" />
          <span class="min-w-0">{{ page.title }}</span>
        </NuxtLink>
      </template>
    </template>

    <section v-if="related.length" class="vh-docs-sidebar-related" aria-label="Related products">
      <h2 class="vh-docs-sidebar-heading">Related</h2>
      <NuxtLink
        v-for="relatedSection in related"
        :key="relatedSection.id"
        :to="docsSectionHome(relatedSection)"
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
        class="vh-docs-sidebar-link"
      >
        <UIcon :name="icons.section(catalogSection)" class="size-4 shrink-0" />
        <span class="min-w-0">{{ catalogSection.title }}</span>
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

/* The site areas lead Get started, or the whole list without a rail. A rule separates them from the section pages. */
.vh-docs-sidebar-site-areas {
  margin-bottom: 0.5rem;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border) 65%, transparent);
  padding-bottom: 0.5rem;
}

.vh-docs-sidebar-site-areas + .vh-docs-sidebar-page-group,
.vh-docs-sidebar-site-areas + .vh-docs-sidebar-category {
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

/* A long title wraps instead of being cut off. The icon stays on its first line. */
.vh-docs-sidebar-link {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  border-left: 2px solid transparent;
  padding: 0.25rem 1.25rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  line-height: 1.25rem;
  transition:
    border-color 150ms ease,
    background-color 150ms ease,
    color 150ms ease;
}

.vh-docs-sidebar-link > .iconify {
  margin-top: 0.125rem;
}

/* Touch devices keep 44px tap targets at every viewport width. */
@media (pointer: coarse) {
  .vh-docs-sidebar-link {
    min-height: 2.75rem;
  }
}

/* Center menu rows below the same 64rem handoff as the desktop sidebar. */
@media (width < 64rem) {
  .vh-docs-sidebar-link {
    align-items: center;
  }

  .vh-docs-sidebar-link > .iconify {
    margin-top: 0;
  }
}

.vh-docs-sidebar-link.is-grouped {
  padding-left: 2rem;
}

/* In a list of sections, the pages of a section line up with its title: the row padding, the icon, and the gap. */
.vh-docs-sidebar-link.is-nested,
.vh-docs-sidebar-page-group-heading.is-nested {
  padding-left: 2.875rem;
}

/* A section without a listed home page has a title row that opens nothing. */
.vh-docs-sidebar-section-title {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  margin: 0;
  padding: 0.25rem 1.25rem;
  color: var(--ui-text);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25rem;
}

.vh-docs-sidebar-section-title > .iconify {
  margin-top: 0.125rem;
}

/* Hover and focus only tint the row. The left rule marks the current page, so a hovered row never looks current. */
.vh-docs-sidebar-link:focus-visible {
  background: color-mix(in srgb, var(--ui-text-highlighted) 4%, transparent);
  color: var(--ui-text);
}

@media (hover: hover) {
  .vh-docs-sidebar-link:hover {
    background: color-mix(in srgb, var(--ui-text-highlighted) 4%, transparent);
    color: var(--ui-text);
  }
}

.vh-docs-sidebar-link.is-active {
  border-left-color: var(--ui-text-highlighted);
  background: color-mix(in srgb, var(--ui-text-highlighted) 7%, transparent);
  color: var(--ui-text-highlighted);
}

/* Related sits at the foot of the list, just above the panel footer, which draws the only rule. */
.vh-docs-sidebar-related {
  margin-top: auto;
  padding-top: 0.75rem;
}
</style>
