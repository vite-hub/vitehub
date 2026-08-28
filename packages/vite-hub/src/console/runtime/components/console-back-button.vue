<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";

import { resolveConsoleRouteName } from "../console-route";

defineProps<{ collapsed: boolean }>();

const route = useRoute();
const router = useRouter();

async function goBack(): Promise<void> {
  await router.push({ name: resolveConsoleRouteName(route.name, "vitehub-console") });
}
</script>

<template>
  <UTooltip text="All sections" :disabled="!collapsed" :content="{ side: 'right' }">
    <UButton
      :aria-label="collapsed ? 'All sections' : undefined"
      block
      class="justify-start"
      color="neutral"
      icon="i-lucide-arrow-left"
      :label="collapsed ? undefined : 'All sections'"
      variant="ghost"
      @click="goBack"
    />
  </UTooltip>
</template>
