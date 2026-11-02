<script setup lang="ts">
import { isPrimitiveIconName, PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem } from "@vite-hub/ui/primitive-rail"
import { NuxtLink } from "#components"
import { docsRailGroups } from "#docs/navigation"

import type { DocsSection } from "@vite-hub/docs"

const { categories, railExclude, site, start } = useDocsConfig()
const currentSection = useDocsSection()
const icons = useDocsIcons()
// One rail group for each catalog category. Sections without a category stay reachable in a last group.
// Each section shows a rail icon by name when the rail has one, and its Iconify icon otherwise.
const groups = docsRailGroups(useDocsManifest(), categories, railExclude).map(sections => sections.map((section) => {
  const icon = icons.rail(section)
  return { section, icon, railIcon: isPrimitiveIconName(icon) ? icon : null }
}))
const brand = site.badge ? `${site.name} ${site.badge.label}` : site.name

// A section that the rail leaves out, such as a shared reference topic, marks the start section.
function isCurrent(section: DocsSection) {
  const current = currentSection.value
  if (!current) return false
  return section.id === current.id || (section.id === start?.section && !!current.category && railExclude.includes(current.category))
}
</script>

<template>
  <!-- The expanded rail shows each label, so the tooltips turn off while it is open. -->
  <PrimitiveRail :label="`${site.name} navigation`">
    <!-- Docs pages have no site header, so the rail carries the brand. It opens the home page. -->
    <template #header="{ expanded }">
      <UTooltip :text="brand" :content="{ side: 'right', sideOffset: 6 }" :delay-duration="150" :disabled="expanded">
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
          v-for="{ section, icon, railIcon } in items"
          :key="section.id"
          :text="section.title"
          :content="{ side: 'right', sideOffset: 6 }"
          :delay-duration="150"
          :disabled="expanded"
        >
          <PrimitiveRailItem
            v-if="railIcon"
            :as="NuxtLink"
            :to="section.path"
            :current="isCurrent(section)"
            :icon="railIcon"
            :label="section.title"
          />
          <PrimitiveRailItem v-else :as="NuxtLink" :to="section.path" :current="isCurrent(section)" :label="section.title">
            <UIcon :name="icon" class="size-4" />
          </PrimitiveRailItem>
        </UTooltip>
      </PrimitiveRailGroup>
    </template>
  </PrimitiveRail>
</template>

<style scoped>
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
