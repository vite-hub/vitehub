<script setup lang="ts">
import { docsPanelOf, docsPanelPages } from "#docs/navigation"

// `::page-list` lists the pages of a section under their sidebar groups, each with its icon and description, so an
// Overview can link every page without keeping a list by hand. On a panel Overview it lists the pages of the panel.
// Its own content is the list agents read in the Markdown copy; the site leaves it out.
const props = defineProps<{
  /** The section to list, by id. Defaults to the section of the page. */
  section?: string
  /** One sidebar group to list, such as `Runtime errors`. */
  group?: string
  /** Sidebar groups to leave out, comma-separated, such as `Start`. */
  exclude?: string
  /**
   * One line per page without icons, for long lists such as one page per error code. It renders a tenth of the markup
   * of a Markdown table, so a list of a thousand pages stays far below the 2 MB that crawlers read.
   */
  compact?: boolean
}>()

const manifest = useDocsManifest()
const current = useDocsSection()
const page = useDocsPage()
const icons = useDocsIcons()
const groups = computed(() => {
  const section = props.section ? manifest.sections.find(candidate => candidate.id === props.section) : current.value
  const exclude = new Set((props.exclude ?? "").split(",").map(name => name.trim()).filter(Boolean))
  // Pages in the panel of the current page, or outside every panel: the section sidebar links each panel once.
  const panel = section && !props.section && page.value ? docsPanelOf(section, page.value.page) : null
  const grouped = new Map<string, NonNullable<typeof section>["pages"]>()
  for (const candidate of section ? docsPanelPages(section, panel) : []) {
    const label = candidate.group?.trim() ?? ""
    if (candidate.navigation === false || candidate.path === page.value?.page.path || exclude.has(label)) continue
    if (props.group !== undefined && label !== props.group) continue
    grouped.set(label, [...(grouped.get(label) ?? []), candidate])
  }
  return [...grouped].map(([label, pages]) => ({ label, pages }))
})
</script>

<template>
  <div v-if="compact" class="vh-page-list">
    <section v-for="group in groups" :key="group.label">
      <h3 v-if="group.label && group.label !== props.group" class="vh-page-list-group">{{ group.label }}</h3>
      <ul class="vh-page-list-compact">
        <li v-for="item in group.pages" :key="item.path">
          <NuxtLink :to="item.path">{{ item.title }}</NuxtLink>
          <span v-if="item.description">{{ item.description }}</span>
        </li>
      </ul>
    </section>
  </div>
  <div v-else class="vh-page-list">
    <section v-for="group in groups" :key="group.label">
      <h3 v-if="group.label" class="vh-page-list-group">{{ group.label }}</h3>
      <ul>
        <li v-for="item in group.pages" :key="item.path">
          <NuxtLink :to="item.path" class="vh-page-list-link">
            <span class="vh-page-list-icon">
              <UIcon :name="icons.page(item)" class="size-4" aria-hidden="true" />
            </span>
            <span class="vh-page-list-text">
              <span class="vh-page-list-title">{{ item.title }}</span>
              <span v-if="item.description" class="vh-page-list-description">{{ item.description }}</span>
            </span>
            <UIcon name="i-lucide-arrow-right" class="vh-page-list-arrow size-4" aria-hidden="true" />
          </NuxtLink>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
/* One track no wider than the page, so a long description truncates instead of widening the list. */
.vh-page-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 2rem;
  margin-block: 2rem;
}

.vh-page-list-group {
  margin: 0 0 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.vh-page-list ul {
  margin: 0;
  padding: 0;
  list-style: none;
  border-block: 1px solid var(--ui-border);
}

.vh-page-list li + li {
  border-top: 1px solid var(--ui-border);
}

/* Plain elements under one class: a list of a thousand rows must not repeat a class on each element. */
.vh-page-list-compact li {
  display: grid;
  grid-template-columns: minmax(0, 14rem) minmax(0, 1fr);
  gap: 0.25rem 1rem;
  padding-block: 0.5rem;
  font-size: 0.875rem;
  line-height: 1.5rem;
}

.vh-page-list-compact a {
  overflow-wrap: anywhere;
  color: var(--ui-text-highlighted);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  text-decoration: underline;
  text-decoration-color: var(--ui-border);
  text-underline-offset: 0.2em;
}

.vh-page-list-compact span {
  color: var(--ui-text-muted);
}

@media (hover: hover) {
  .vh-page-list-compact a:hover {
    text-decoration-color: currentColor;
  }
}

@media (max-width: 40rem) {
  .vh-page-list-compact li {
    grid-template-columns: minmax(0, 1fr);
  }
}

.vh-page-list-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-block: 0.75rem;
  color: inherit;
  text-decoration: none;
  transition: background-color 150ms ease;
}


.vh-page-list-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-muted);
}

.vh-page-list-text {
  min-width: 0;
  flex: 1;
}

.vh-page-list-title {
  display: block;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
}

.vh-page-list-description {
  display: block;
  margin-top: 0.125rem;
  overflow: hidden;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  line-height: 1.25rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vh-page-list-arrow {
  flex: none;
  color: var(--ui-text-dimmed);
  transition: transform 150ms ease, color 150ms ease;
}

@media (hover: hover) {
  .vh-page-list-link:hover {
    background: color-mix(in srgb, var(--ui-bg-elevated) 45%, transparent);
  }

  .vh-page-list-link:hover .vh-page-list-icon,
  .vh-page-list-link:hover .vh-page-list-arrow {
    color: var(--ui-text-highlighted);
  }

  .vh-page-list-link:hover .vh-page-list-arrow {
    transform: translateX(2px);
  }
}
</style>
