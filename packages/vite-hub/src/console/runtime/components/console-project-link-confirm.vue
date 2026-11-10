<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";

import type { ConsoleLinkRequest } from "../client/pending-links";
import type { ConsoleProjectProblem } from "../client/project-link";
import { confirmConsoleLink, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";
import ConsoleCodeText from "./console-code-text.vue";
import ConsoleProjectProblemAlert from "./console-project-problem.vue";

/**
 * The `/link` page of a hosted Console. It shows the app of a one-time link and sends nothing until the person confirms
 * it, so a link with another app URL cannot take the key without a click on that host.
 */
const props = defineProps<{ request: ConsoleLinkRequest }>();

const projects = useConsoleProjects();
const busy = ref(false);
// A problem that a retry can fix, such as an app that is offline. It shows below the question.
const problem = shallowRef<ConsoleProjectProblem>();
// A link that cannot be used again replaces the question.
const final = shallowRef<ConsoleProjectProblem>();

const shown = computed(() => final.value ? { kind: "problem" as const, problem: final.value } : props.request);
const host = computed(() => shown.value.kind === "confirm" ? consoleProjectHost(shown.value.target) : "");

async function confirm(): Promise<void> {
  const request = shown.value;
  if (busy.value || request.kind !== "confirm") return;
  busy.value = true;
  problem.value = undefined;
  try {
    const result = await confirmConsoleLink(request.pendingId, request.target);
    if (result.kind === "linked") {
      switchConsoleProject(result.project.id);
      return;
    }
    if (result.final) final.value = result.problem;
    else problem.value = result.problem;
  }
  catch {
    problem.value = { title: "Could not link the project", message: "The check stopped. Try again." };
  }
  busy.value = false;
}

function leave(): void {
  projects.navigate(projects.home);
}
</script>

<template>
  <template v-if="shown.kind === 'confirm'">
    <div class="grid gap-1.5">
      <h1 class="vitehub-project-gate__title">Link <span class="font-mono">{{ host }}</span>?</h1>
      <p class="vitehub-project-gate__text">
        Continue only if you started this app. The Console sends the key of this link to {{ shown.target.url }} and keeps the project in this browser.
      </p>
    </div>
    <ConsoleProjectProblemAlert v-if="problem" :problem="problem" />
    <div class="flex gap-2">
      <UButton :loading="busy" :label="busy ? 'Linking…' : 'Link project'" @click="confirm" />
      <UButton color="neutral" variant="ghost" label="Cancel" :disabled="busy" @click="leave" />
    </div>
  </template>

  <template v-else>
    <div class="grid gap-1.5" role="alert">
      <h1 class="vitehub-project-gate__title">{{ shown.problem.title }}</h1>
      <p class="vitehub-project-gate__text"><ConsoleCodeText :text="shown.problem.message" /></p>
      <p v-if="shown.problem.fix" class="vitehub-project-gate__fix"><ConsoleCodeText :text="shown.problem.fix" /></p>
    </div>
    <UButton label="Open Console" class="justify-self-start" @click="leave" />
  </template>
</template>
