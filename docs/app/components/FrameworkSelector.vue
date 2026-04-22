<script setup lang="ts">
import { ref } from "vue";
import { useFrameworkPreference } from "../composables/useFrameworkPreference";
import {
  frameworkColorIcons,
  frameworkDescriptions,
  frameworkLabels,
  type Framework,
  visibleFrameworks,
} from "~~/modules/vitehub-docs/runtime/utils/frameworks";

const open = ref(false);
const { current, switchTo } = useFrameworkPreference();

function select(fw: Framework) {
  switchTo(fw);
  open.value = false;
}
</script>

<template>
  <UPopover v-model:open="open" :ui="{ content: 'w-(--reka-popover-trigger-width)' }">
    <button
      type="button"
      class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left ring-1 ring-black/10 hover:bg-muted/20 dark:ring-white/10"
    >
      <UIcon :name="frameworkColorIcons[current]" class="size-5 shrink-0" />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium text-highlighted">{{ frameworkLabels[current] }}</div>
        <div class="text-xs text-muted">{{ frameworkDescriptions[current] }}</div>
      </div>
      <UIcon name="i-lucide-chevrons-up-down" class="size-3.5 shrink-0 text-muted" />
    </button>

    <template #content>
      <div class="p-1" role="listbox">
        <button
          v-for="fw in visibleFrameworks"
          :key="fw"
          type="button"
          role="option"
          :aria-selected="current === fw"
          class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
          :class="current === fw ? 'bg-muted/50' : 'hover:bg-muted/30'"
          @click="select(fw)"
        >
          <UIcon :name="frameworkColorIcons[fw]" class="size-4 shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium" :class="current === fw ? 'text-highlighted' : 'text-default'">{{ frameworkLabels[fw] }}</div>
            <div class="text-xs text-muted">{{ frameworkDescriptions[fw] }}</div>
          </div>
          <UIcon v-if="current === fw" name="i-lucide-check" class="size-3.5 shrink-0 text-primary" />
        </button>
      </div>
    </template>
  </UPopover>
</template>
