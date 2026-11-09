<script setup lang="ts">
import { CopyButton } from "@vite-hub/ui";
import { installOptions } from "./content";

const commandTabItems = [
  { label: "For Agents", value: installOptions.skill.value, icon: installOptions.skill.icon },
  { label: "For humans", value: "package", icon: "i-lucide-package" },
];
const packageManagerItems = installOptions.packages.map((option) => ({ ...option }));

// UTabs emits plain strings, so the lookups below fall back to the first option.
const activeTab = ref<string>("package");
const activePackageManager = ref<string>("pnpm");

const selectedPackageManager = computed(
  () =>
    installOptions.packages.find((option) => option.value === activePackageManager.value) ??
    installOptions.packages[0],
);
const activeCommand = computed(() =>
  activeTab.value === "skill" ? installOptions.skill.command : selectedPackageManager.value.command,
);
</script>

<template>
  <div class="flex w-full flex-col overflow-hidden rounded-lg border border-default bg-default">
    <!-- On phones each strip takes its own row, and the first strip's underline divides them. -->
    <div class="flex flex-wrap items-stretch justify-between border-b border-default">
      <UTabs v-model="activeTab" :items="commandTabItems" :content="false" class="max-sm:w-full" />

      <UTabs
        v-show="activeTab === 'package'"
        v-model="activePackageManager"
        :items="packageManagerItems"
        :content="false"
        class="max-sm:w-full"
      >
        <template #default="{ item }">
          <span class="sr-only">{{ item.label }}</span>
        </template>
      </UTabs>
    </div>

    <div class="flex min-h-12 w-full items-center gap-2 bg-muted px-4 py-2">
      <span class="font-mono text-xs text-dimmed select-none sm:text-sm" aria-hidden="true">$</span>
      <span class="relative min-w-0 flex-1 overflow-hidden font-mono text-xs text-highlighted sm:text-sm">
        <Transition name="command-swap" mode="out-in">
          <code
            :key="activeCommand"
            class="block overflow-x-auto whitespace-nowrap py-1 [scrollbar-width:none]"
          >
            {{ activeCommand }}
          </code>
        </Transition>
      </span>
      <!-- The key resets the check when the command changes, so it shows only for the command that was copied. -->
      <CopyButton :key="activeCommand" :value="activeCommand" aria-label="Copy install command" />
    </div>
  </div>
</template>

<style scoped>
.command-swap-enter-active,
.command-swap-leave-active {
  transition:
    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.command-swap-enter-from,
.command-swap-leave-to {
  opacity: 0;
  transform: translateY(2px);
}

@media (prefers-reduced-motion: reduce) {
  .command-swap-enter-active,
  .command-swap-leave-active {
    transition: none;
  }

  .command-swap-enter-from,
  .command-swap-leave-to {
    transform: none;
  }
}
</style>
