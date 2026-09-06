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
const navigationFailed = ref(false);
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

async function loadSections(): Promise<void> {
  navigationFailed.value = false;
  const navigation = await loadConsoleNavigation(props.sectionsBase);
  if (!navigation) {
    navigationFailed.value = true;
    return;
  }
  sections.value = navigation.sections;
}

onMounted(loadSections);
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
    <UTooltip v-if="navigationFailed" text="Retry loading primitives">
      <UButton
        aria-label="Retry loading primitives"
        color="neutral"
        icon="i-ph-arrow-clockwise"
        size="xs"
        variant="ghost"
        @click="loadSections"
      />
    </UTooltip>
  </nav>
</template>
