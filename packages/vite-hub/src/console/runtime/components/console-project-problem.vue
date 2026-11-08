<script setup lang="ts">
import type { ConsoleProjectProblem } from "../client/project-link";
import ConsoleCodeText from "./console-code-text.vue";

/**
 * Why the last check did not open the project, under the control that started it. Long URLs and names wrap, and names in
 * backticks render as code. A problem with an empty message shows only its title.
 */
defineProps<{ problem: ConsoleProjectProblem }>();
</script>

<template>
  <div role="alert" class="flex gap-2 text-sm">
    <UIcon name="i-lucide-circle-alert" class="mt-0.5 size-4 shrink-0 text-error" aria-hidden="true" />
    <div class="grid min-w-0 gap-0.5 [overflow-wrap:anywhere]">
      <p class="text-pretty font-medium text-highlighted">{{ problem.title }}</p>
      <p v-if="problem.message" class="text-pretty text-muted"><ConsoleCodeText :text="problem.message" /></p>
      <p v-if="problem.fix" class="mt-1 text-pretty text-default"><ConsoleCodeText :text="problem.fix" /></p>
    </div>
  </div>
</template>
