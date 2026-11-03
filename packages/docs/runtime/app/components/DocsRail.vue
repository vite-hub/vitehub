<script setup lang="ts">
import { PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem, resolvePrimitiveIconName } from "@vite-hub/ui/primitive-rail"
import { NuxtLink } from "#components"
import { docsRailGroups, docsSectionHome } from "#docs/navigation"

import type { ComponentPublicInstance } from "vue"
import type { DocsSection } from "@vite-hub/docs"

defineProps<{
  /** Shows every label, with no tooltips. Touch has no hover to expand the rail. */
  labeled?: boolean
}>()

const { categories, railExclude, site, start } = useDocsConfig()
const currentSection = useDocsSection()
const icons = useDocsIcons()
// One rail group for each catalog category. Sections without a category stay reachable in a last group.
// A section icon from the ViteHub set (`i-vitehub-kv`, or `kv` in the `rail` option) renders inline, so it can move on
// hover. Any other Iconify icon renders through UIcon.
const groups = docsRailGroups(useDocsManifest(), categories, railExclude).map(sections => sections.map((section) => {
  const icon = icons.rail(section)
  return { section, to: docsSectionHome(section), icon, railIcon: resolvePrimitiveIconName(icon) ?? null }
}))
const brand = site.badge ? `${site.name} ${site.badge.label}` : site.name

// A section that the rail leaves out, such as a shared reference topic, marks the start section.
function isCurrent(section: DocsSection) {
  const current = currentSection.value
  if (!current) return false
  return section.id === current.id || (section.id === start?.section && !!current.category && railExclude.includes(current.category))
}

// The sidebar link is the current page, so the rail marks its section with aria-current="true", not "page".
function ariaCurrent(section: DocsSection) {
  return isCurrent(section) ? "true" : undefined
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
    <!-- Docs pages have no site header, so the rail carries the brand. It opens the home page. -->
    <template #header="{ expanded }">
      <UTooltip :text="brand" :content="{ side: 'right', sideOffset: 6 }" :delay-duration="150" :disabled="expanded || labeled">
        <PrimitiveRailItem :as="NuxtLink" to="/" :label="brand" class="vh-docs-rail-brand">
          <span v-if="site.logo" class="vh-docs-rail-brand-mark" :style="{ '--vh-docs-logo': `url(${site.logo})` }" />
          <span v-else class="vh-docs-rail-brand-initial">{{ site.name.charAt(0) }}</span>
          <template #label>
            <span class="vh-docs-rail-brand-name">{{ site.name }}</span>
            <span v-if="site.badge" class="vh-docs-rail-brand-badge">{{ site.badge.label }}</span>
          </template>
        </PrimitiveRailItem>
      </UTooltip>
    </template>
    <template #default="{ expanded }">
      <PrimitiveRailGroup v-for="(items, index) in groups" :key="index">
        <UTooltip
          v-for="{ section, to, icon, railIcon } in items"
          :key="section.id"
          :text="section.title"
          :content="{ side: 'right', sideOffset: 6 }"
          :delay-duration="150"
          :disabled="expanded || labeled"
        >
          <PrimitiveRailItem
            v-if="railIcon"
            :as="NuxtLink"
            :to="to"
            :current="isCurrent(section)"
            :aria-current="ariaCurrent(section)"
            :icon="railIcon"
            :label="section.title"
          />
          <PrimitiveRailItem v-else :as="NuxtLink" :to="to" :current="isCurrent(section)" :aria-current="ariaCurrent(section)" :label="section.title">
            <UIcon :name="icon" class="size-4" />
          </PrimitiveRailItem>
        </UTooltip>
      </PrimitiveRailGroup>
    </template>
  </PrimitiveRail>
</template>

<style scoped>
/* The shared rail styles the current item by aria-current="page". The docs rail uses "true", so it repeats that style. */
.vh-docs-rail :deep(.vh-primitive-rail__item[aria-current="true"]) {
  background: var(--vh-ui-bg-accented);
  color: var(--vh-ui-highlighted);
}

@media (hover: hover) {
  .vh-docs-rail :deep(.vh-primitive-rail__item[aria-current="true"]:hover) {
    background: var(--vh-ui-bg-accented);
  }
}

.vh-docs-rail :deep(.vh-primitive-rail__body[data-fade-top]),
.vh-docs-rail :deep(.vh-primitive-rail__body[data-fade-bottom]) {
  --vh-docs-rail-fade-top: 0px;
  --vh-docs-rail-fade-bottom: 0px;
  mask-image: linear-gradient(to bottom, transparent, #000 var(--vh-docs-rail-fade-top), #000 calc(100% - var(--vh-docs-rail-fade-bottom)), transparent);
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

/* The mark is a mask filled with the text color, so it follows light and dark mode without a frame. */
.vh-docs-rail-brand-mark {
  display: block;
  width: 1.125rem;
  height: 1rem;
  background-color: var(--ui-text-highlighted);
  mask: var(--vh-docs-logo) center / contain no-repeat;
}

.vh-docs-rail-brand-initial {
  color: var(--ui-text-highlighted);
  font-weight: 650;
}

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
