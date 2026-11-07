<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";

import type { ConsoleProjectProblem } from "../client/project-link";
import type { ConsoleProjectTarget } from "../client/projects";
import { startConsoleOAuthSignIn } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";
import ConsoleProjectProblemAlert from "./console-project-problem.vue";

/**
 * The sign-in step of a project with `auth: "app"`: one button that opens the sign-in page of the project. `problem`
 * says why the last sign-in did not open the project.
 */
const props = defineProps<{
  target: ConsoleProjectTarget;
  resourceMetadata?: string;
  problem?: ConsoleProjectProblem;
}>();

const busy = ref(false);
const startProblem = shallowRef<ConsoleProjectProblem>();
const host = computed(() => consoleProjectHost(props.target));
const shown = computed(() => startProblem.value ?? props.problem);

watch(() => props.target.url, () => {
  startProblem.value = undefined;
});

// In the Link project dialog the person just pressed Continue, so the keyboard moves on to the only action here. The full
// page and a touch screen move no focus.
const button = useTemplateRef<{ $el: HTMLElement }>("button");
onMounted(() => {
  const element = button.value?.$el;
  if (element?.closest("[role=dialog]") && !("ontouchstart" in window)) element.focus();
});

async function signIn(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  startProblem.value = undefined;
  try {
    // When the sign-in starts, the page leaves for the project, so the button stays busy.
    startProblem.value = await startConsoleOAuthSignIn(props.target, props.resourceMetadata);
  }
  catch {
    startProblem.value = { title: "The sign-in did not start", message: `The Console could not reach ${host.value}. Check the connection and try again.` };
  }
  if (startProblem.value) busy.value = false;
}
</script>

<template>
  <div class="grid gap-4">
    <ConsoleProjectProblemAlert v-if="shown" :problem="shown" />
    <UButton
      ref="button"
      block
      icon="i-lucide-log-in"
      :loading="busy"
      :label="busy ? `Opening ${host}…` : `Sign in with ${host}`"
      @click="signIn"
    />
    <p class="text-xs text-dimmed text-pretty [overflow-wrap:anywhere]">
      You sign in on {{ host }}, and it asks you to allow this Console. The Console keeps the access in this browser.
    </p>
  </div>
</template>
