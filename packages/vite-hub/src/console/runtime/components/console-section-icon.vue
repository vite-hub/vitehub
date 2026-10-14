<script setup lang="ts">
import { PrimitiveIcon } from "@vite-hub/ui/primitive-rail";
import { computed } from "vue";

import type { ConsoleSectionId } from "../sections";
import { consoleSectionRailIcon } from "../sections";

const props = defineProps<{
  /** Iconify name from the section details. Only a contributed section that the Console does not know shows it. */
  icon: string;
  section: ConsoleSectionId;
}>();

const railIcon = computed(() => consoleSectionRailIcon(props.section));
</script>

<template>
  <!-- Known primitives use the shared docs and rail icon family. A contributed section keeps the icon of its descriptor. -->
  <PrimitiveIcon v-if="railIcon" :name="railIcon" />
  <UIcon v-else :name="icon" aria-hidden="true" />
</template>
