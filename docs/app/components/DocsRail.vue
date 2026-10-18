<script setup lang="ts">
import { PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem } from "@vite-hub/ui/primitive-rail";
import { NuxtLink } from "#components";
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  getDocsRailCatalog,
  getUncategorizedDocsSections,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const currentSection = useDocsSection();
// One rail group for each catalog category. Sections without a category stay reachable in a last group.
const groups = [
  ...getDocsRailCatalog(docsManifest.sections).map((group) => group.sections),
  getUncategorizedDocsSections(docsManifest.sections),
].filter((sections) => sections.length > 0);
</script>

<template>
  <!-- The expanded rail shows each label, so the tooltips turn off while it is open. -->
  <PrimitiveRail label="ViteHub navigation">
    <!-- Docs pages have no site header, so the rail carries the brand. It opens the home page. -->
    <template #header="{ expanded }">
      <UTooltip text="ViteHub alpha" :content="{ side: 'right', sideOffset: 6 }" :delay-duration="150" :disabled="expanded">
        <PrimitiveRailItem :as="NuxtLink" to="/" label="ViteHub alpha" class="vh-docs-rail-brand">
          <span class="vh-docs-rail-brand-mark" />
          <template #label>
            <span class="vh-docs-rail-brand-name">ViteHub</span>
            <span class="vh-docs-rail-brand-alpha">alpha</span>
          </template>
        </PrimitiveRailItem>
      </UTooltip>
    </template>
    <template #default="{ expanded }">
      <PrimitiveRailGroup v-for="(sections, index) in groups" :key="index">
        <UTooltip
          v-for="section in sections"
          :key="section.id"
          :text="section.title"
          :content="{ side: 'right', sideOffset: 6 }"
          :delay-duration="150"
          :disabled="expanded"
        >
          <PrimitiveRailItem
            :as="NuxtLink"
            :to="section.path"
            :current="section.id === currentSection?.id || (section.id === 'getting-started' && currentSection?.category === 'Platform')"
            :icon="railSectionIcon(section)"
            :label="section.title"
          />
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
  mask: url("/vitehub-mark.svg") center / contain no-repeat;
}

.vh-docs-rail-brand-name {
  color: var(--ui-text-highlighted);
  font-weight: 650;
}

.vh-docs-rail-brand-alpha {
  margin-inline-start: 0.375rem;
  border-bottom: 1px dotted currentcolor;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.625rem;
}
</style>
