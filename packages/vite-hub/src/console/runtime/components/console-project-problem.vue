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
  <UAlert role="alert" color="error" icon="i-lucide-circle-alert" :title="problem.title" class="[overflow-wrap:anywhere]">
    <template v-if="problem.message || problem.fix" #description>
      <p v-if="problem.message" class="text-pretty"><ConsoleCodeText :text="problem.message" /></p>
      <p v-if="problem.fix" class="mt-1 text-pretty"><ConsoleCodeText :text="problem.fix" /></p>
    </template>
  </UAlert>
</template>
