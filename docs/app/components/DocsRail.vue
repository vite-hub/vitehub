<script setup lang="ts">
import { PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem } from "@vite-hub/ui/primitive-rail";
import { NuxtLink } from "#components";
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  getDocsRailCatalog,
  getDocsSectionForPath,
  getUncategorizedDocsSections,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const currentSection = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
// One rail group for each catalog category. Sections without a category stay reachable in a last group.
const groups = [
  ...getDocsRailCatalog(docsManifest.sections).map((group) => group.sections),
  getUncategorizedDocsSections(docsManifest.sections),
].filter((sections) => sections.length > 0);
</script>

<template>
  <!-- The expanded rail shows each label, so the tooltips turn off while it is open. -->
  <PrimitiveRail v-slot="{ expanded }" label="Docs sections">
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
  </PrimitiveRail>
</template>
