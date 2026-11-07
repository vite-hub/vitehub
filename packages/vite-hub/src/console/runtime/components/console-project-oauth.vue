<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";

import type { ConsoleProjectProblem } from "../client/project-link";
import type { ConsoleProjectTarget } from "../client/projects";
import { startConsoleOAuthSignIn } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";

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
    <div v-if="shown" role="alert" class="flex gap-2 text-sm">
      <UIcon name="i-lucide-circle-alert" class="mt-0.5 size-4 shrink-0 text-error" aria-hidden="true" />
      <div class="grid gap-0.5">
        <p class="font-medium text-highlighted">{{ shown.title }}</p>
        <p class="text-pretty text-muted">{{ shown.message }}</p>
      </div>
    </div>
    <UButton
      block
      icon="i-lucide-log-in"
      :loading="busy"
      :label="busy ? `Opening ${host}…` : `Sign in with ${host}`"
      @click="signIn"
    />
    <p class="text-xs text-dimmed text-pretty">
      You sign in on {{ host }}, and it asks you to allow this Console. The Console keeps the access in this browser.
    </p>
  </div>
</template>
