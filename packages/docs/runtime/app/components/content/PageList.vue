<script setup lang="ts">
import { docsPanelOf } from "#docs/navigation"

// `::page-list` lists the pages of a section under their sidebar groups, each with its icon and description, so an
// Overview can link every page without keeping a list by hand. Its own content is the list agents read in the
// Markdown copy; the site leaves it out.
const props = defineProps<{
  /** The section to list, by id. Defaults to the section of the page. */
  section?: string
  /** Sidebar groups to leave out, comma-separated, such as `Start`. */
  exclude?: string
}>()

const manifest = useDocsManifest()
const current = useDocsSection()
const page = useDocsPage()
const icons = useDocsIcons()
const groups = computed(() => {
  const section = props.section ? manifest.sections.find(candidate => candidate.id === props.section) : current.value
  const exclude = new Set((props.exclude ?? "").split(",").map(name => name.trim()).filter(Boolean))
  const grouped = new Map<string, NonNullable<typeof section>["pages"]>()
  for (const candidate of section?.pages ?? []) {
    const label = candidate.group?.trim() ?? ""
    // Pages inside a panel belong to the panel's own sidebar. The panel's Overview links to them.
    if (candidate.navigation === false || candidate.path === page.value?.page.path || exclude.has(label) || (!candidate.panel && docsPanelOf(section!, candidate))) continue
    grouped.set(label, [...(grouped.get(label) ?? []), candidate])
  }
  return [...grouped].map(([label, pages]) => ({ label, pages }))
})
</script>

<template>
  <div class="vh-page-list">
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
