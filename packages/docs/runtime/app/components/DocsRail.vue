<script setup lang="ts">
import { PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem, resolvePrimitiveIconName } from "#docs/primitive-rail"
import { NuxtLink } from "#components"
import { docsHomePath, docsPanelOf, docsRailEntries, docsRailTarget, docsStartPage, normalizeDocsPath } from "#docs/navigation"

import type { ComponentPublicInstance } from "vue"
import type { DocsAppPage, DocsRailEntry, DocsSection } from "@vite-hub/docs"

defineProps<{
  /** Shows every label, with no tooltips. Touch has no hover to expand the rail. */
  labeled?: boolean
  /** Shows the brand at the top, for the sidebar of wide screens, which have no site header beside it. */
  brand?: boolean
  /**
   * Shows a button under the brand that opens or collapses the sidebar, on a page with a collapsible sidebar. Collapsed,
   * the rail is the whole sidebar, so it also shows search and the site links.
   */
  toggle?: "show" | "hide"
}>()

const { categories, railExclude, groups: docsGroups, site, start } = useDocsConfig()
const { toggle: toggleSidebar, focusMounted } = useDocsSidebarToggle()
const search = reactive(useContentSearch())
onMounted(focusMounted)
const currentSection = useDocsSection()
const icons = useDocsIcons()
// One rail group for each catalog category. Sections without a category stay reachable in a last group. The sections
// of a docs group share one item, which opens the first of them.
// A section icon from the ViteHub set (`i-vitehub-kv`, or `kv` in the `rail` option) renders inline, so it can move on
// hover. Any other Iconify icon renders through UIcon.
const groups = docsRailEntries(useDocsManifest(), { categories, railExclude, groups: docsGroups }).map(entries => entries.map((entry) => {
  const icon = entry.icon ?? icons.rail(entry.sections[0]!)
  return { entry, icon, railIcon: resolvePrimitiveIconName(icon) ?? null }
}))
const route = useRoute()
// Inside a panel, such as the diagnostics of one section, each rail item opens the same panel of its own section.
const currentPanel = computed(() => {
  const section = currentSection.value
  const page = section?.pages.find(candidate => candidate.path === normalizeDocsPath(route.path))
  return section && page ? docsPanelOf(section, page) : null
})
// The item of the start section opens the start link that leads it, such as an Introduction outside every section.
const startPage = docsStartPage(useDocsManifest(), start)
function target(entry: DocsRailEntry<DocsAppPage>) {
  const opensStart = startPage && !currentPanel.value && entry.sections.some(section => section.id === start?.section)
  return opensStart ? startPage : docsRailTarget(entry.sections[0]!, currentPanel.value)
}
const brandLabel = site.badge ? `${site.name} ${site.badge.label}` : site.name
const docsHome = docsHomePath(useDocsManifest(), start)
const currentEntry = computed(() => groups.flat().find(({ entry }) => entry.sections.some(section => section.id === currentSection.value?.id)))

// A section that the rail leaves out, such as a shared reference topic, marks the start section.
function isCurrent(section: DocsSection<DocsAppPage>) {
  const current = currentSection.value
  if (!current) return false
  return section.id === current.id || (!currentEntry.value && section.id === start?.section && !!current.category && railExclude.includes(current.category))
}

function isCurrentEntry(entry: DocsRailEntry<DocsAppPage>) {
  return entry.sections.some(isCurrent)
}

// The sidebar link is the current page, so the rail marks its section with aria-current="true", not "page".
function ariaCurrent(entry: DocsRailEntry<DocsAppPage>) {
  return isCurrentEntry(entry) ? "true" : undefined
}

// The rail hides its scrollbar. A fade at the clipped edge shows that more items are above or below.
const rail = useTemplateRef<ComponentPublicInstance>("rail")
let railBody: HTMLElement | null = null
let resize: ResizeObserver | undefined
function updateFade() {
  if (!railBody) return
  const { scrollTop, scrollHeight, clientHeight } = railBody
  railBody.toggleAttribute("data-fade-top", scrollTop > 1)
  railBody.toggleAttribute("data-fade-bottom", scrollTop + clientHeight < scrollHeight - 1)
}
onMounted(() => {
  const element: unknown = rail.value?.$el
  railBody = element instanceof HTMLElement ? element.querySelector<HTMLElement>(".vh-primitive-rail__body") : null
  if (!railBody) return
  railBody.addEventListener("scroll", updateFade, { passive: true })
  resize = new ResizeObserver(updateFade)
  resize.observe(railBody)
  updateFade()
})
onBeforeUnmount(() => {
  railBody?.removeEventListener("scroll", updateFade)
  resize?.disconnect()
})
</script>

<template>
  <!-- The expanded rail shows each label, so the tooltips turn off while it is open. -->
  <PrimitiveRail ref="rail" :label="`${site.name} navigation`" class="vh-docs-rail" :class="{ 'vh-docs-rail-labeled': labeled }">
    <!-- Like the header brand on other pages, it opens the docs home. -->
    <template v-if="brand || toggle" #header="{ expanded }">
      <UTooltip
        v-if="brand"
        :text="site.badge?.tooltip || brandLabel"
        :content="{ side: 'right', sideOffset: 6 }"
        :delay-duration="150"
        :disabled="expanded && !site.badge?.tooltip"
        ignore-non-keyboard-focus
        :ui="{ content: 'h-auto max-w-64 whitespace-normal px-3 py-2 text-left leading-5' }"
      >
        <PrimitiveRailItem :as="NuxtLink" :to="docsHome ?? '/'" :label="brandLabel" class="vh-docs-rail-brand">
          <DocsBrandMark v-if="site.logo" />
          <span v-else class="vh-docs-rail-brand-initial">{{ site.name.charAt(0) }}</span>
          <template #label>
            <span class="vh-docs-rail-brand-name">{{ site.name }}</span>
            <span v-if="site.badge" class="vh-docs-rail-brand-badge">{{ site.badge.label }}</span>
          </template>
        </PrimitiveRailItem>
      </UTooltip>
      <!-- The open and collapsed sidebars put this button in the same place, so the pointer can toggle in place. -->
      <UTooltip v-if="toggle" :text="toggle === 'show' ? 'Show navigation' : 'Hide navigation'" :content="{ side: 'right', sideOffset: 6 }" :delay-duration="150" :disabled="expanded" ignore-non-keyboard-focus>
        <PrimitiveRailItem
          :id="docsSidebarToggleIds[toggle]"
          as="button"
          type="button"
          :label="toggle === 'show' ? 'Show navigation' : 'Hide navigation'"
          @click="toggleSidebar(toggle === 'show')"
        >
          <UIcon :name="toggle === 'show' ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" class="size-4" />
        </PrimitiveRailItem>
      </UTooltip>
      <UTooltip v-if="toggle === 'show'" text="Search docs" :content="{ side: 'right', sideOffset: 6 }" :delay-duration="150" :disabled="expanded">
        <PrimitiveRailItem as="button" type="button" label="Search docs" @click="search.open = true">
          <UIcon name="i-lucide-search" class="size-4" />
        </PrimitiveRailItem>
      </UTooltip>
    </template>
    <template #default="{ expanded }">
      <PrimitiveRailGroup v-for="(items, index) in groups" :key="index">
        <UTooltip
          v-for="{ entry, icon, railIcon } in items"
          :key="entry.sections[0]!.id"
          :text="entry.title"
          :content="{ side: 'right', sideOffset: 6 }"
          :delay-duration="150"
          :disabled="expanded || labeled"
        >
          <PrimitiveRailItem
            v-if="railIcon"
            :as="NuxtLink"
            :to="target(entry)"
            :current="isCurrentEntry(entry)"
            :aria-current="ariaCurrent(entry)"
            :icon="railIcon"
            :label="entry.title"
          />
          <PrimitiveRailItem v-else :as="NuxtLink" :to="target(entry)" :current="isCurrentEntry(entry)" :aria-current="ariaCurrent(entry)" :label="entry.title">
            <UIcon :name="icon" class="size-4" />
          </PrimitiveRailItem>
        </UTooltip>
      </PrimitiveRailGroup>
    </template>
    <template v-if="toggle === 'show'" #footer>
      <DocsAsideFooter stacked />
    </template>
  </PrimitiveRail>
</template>

<style scoped>
/* The shared rail styles the current item by aria-current="page". The docs rail uses "true", so it repeats that style:
   the soft surface of the old comark-ui rail with a hairline ring. */
.vh-docs-rail :deep(.vh-primitive-rail__item[aria-current="true"]) {
  background: var(--ui-bg-elevated);
  box-shadow: inset 0 0 0 1px var(--ui-border);
  color: var(--ui-text-highlighted);
}

@media (hover: hover) {
  .vh-docs-rail :deep(.vh-primitive-rail__item[aria-current="true"]:hover) {
    background: var(--ui-bg-elevated);
  }
}

.vh-docs-rail :deep(.vh-primitive-rail__body[data-fade-top]),
.vh-docs-rail :deep(.vh-primitive-rail__body[data-fade-bottom]) {
  --vh-docs-rail-fade-top: 0px;
  --vh-docs-rail-fade-bottom: 0px;
  /* A mask reads only alpha, so any opaque color works. */
  mask-image: linear-gradient(to bottom, transparent, black var(--vh-docs-rail-fade-top), black calc(100% - var(--vh-docs-rail-fade-bottom)), transparent);
}

.vh-docs-rail :deep(.vh-primitive-rail__body[data-fade-top]) {
  --vh-docs-rail-fade-top: 1.5rem;
}

.vh-docs-rail :deep(.vh-primitive-rail__body[data-fade-bottom]) {
  --vh-docs-rail-fade-bottom: 1.5rem;
}

/* The labeled rail of the mobile menu: a fixed column with every label. Long labels wrap. */
.vh-docs-rail-labeled.vh-primitive-rail {
  width: 10.5rem;
}

.vh-docs-rail-labeled.vh-primitive-rail :deep(.vh-primitive-rail__surface) {
  width: 100%;
}

.vh-docs-rail-labeled :deep(.vh-primitive-rail__item) {
  height: auto;
  min-height: var(--vh-primitive-rail-item);
}

.vh-docs-rail-labeled :deep(.vh-primitive-rail__icon) {
  height: var(--vh-primitive-rail-item);
  align-self: flex-start;
}

.vh-docs-rail-labeled :deep(.vh-primitive-rail__label) {
  opacity: 1;
  padding-block: 0.25rem;
  white-space: normal;
  overflow-wrap: anywhere;
}

.vh-docs-rail-brand {
  --vh-docs-mark-size: 1.125rem;
}

.vh-docs-rail-brand-initial,
.vh-docs-rail-brand-name {
  color: var(--ui-text-highlighted);
  font-weight: 650;
}

.vh-docs-rail-brand-badge {
  margin-inline-start: 0.375rem;
  border-bottom: 1px dotted currentcolor;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.625rem;
}
</style>
