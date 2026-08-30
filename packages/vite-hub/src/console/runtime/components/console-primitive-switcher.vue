<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleSectionId } from "../sections";
import { loadConsoleNavigation } from "../client/sections";
import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionDetails } from "../sections";

const props = defineProps<{
  active?: ConsoleSectionId;
  collapsed: boolean;
  exclude?: ConsoleSectionId[];
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const sections = ref<ConsoleSectionId[]>([]);
const items = computed(() =>
  sections.value
    .filter((section) => !props.exclude?.includes(section))
    .map((section) => ({ id: section, ...consoleSectionDetails[section] })),
);

async function openSection(section: ConsoleSectionId): Promise<void> {
  await router.push({
    name: resolveConsoleRouteName(route.name, consoleSectionDetails[section].routeName),
  });
}

onMounted(async () => {
  sections.value = (await loadConsoleNavigation(props.sectionsBase))?.sections ?? [];
});
</script>

<template>
  <nav v-if="!collapsed" class="flex min-w-0 items-center gap-0.5" aria-label="Console primitives">
    <UTooltip v-for="item in items" :key="item.id" :text="item.label">
      <UButton
        :aria-label="`Open ${item.label}`"
        color="neutral"
        :icon="item.icon"
        size="xs"
        :variant="active === item.id ? 'soft' : 'ghost'"
        @click="openSection(item.id)"
      />
    </UTooltip>
  </nav>
</template>
