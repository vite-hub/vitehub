<script setup lang="ts">
import type { ConsoleProjectProblem } from "../client/project-link";

/** Why the last check did not open the project, under the control that started it. Long URLs and names wrap. */
defineProps<{ problem: ConsoleProjectProblem }>();
</script>

<template>
  <div role="alert" class="flex gap-2 text-sm">
    <UIcon name="i-lucide-circle-alert" class="mt-0.5 size-4 shrink-0 text-error" aria-hidden="true" />
    <div class="grid min-w-0 gap-0.5 [overflow-wrap:anywhere]">
      <p class="font-medium text-highlighted">{{ problem.title }}</p>
      <p class="text-pretty text-muted">{{ problem.message }}</p>
    </div>
  </div>
</template>
