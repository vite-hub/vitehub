<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";

import type { ConsoleProjectProblem } from "../client/project-link";
import { consoleTokenRefused } from "../client/project-link";
import type { ConsoleProjectTarget } from "../client/projects";
import { cancelConsoleOpen, finishConsoleOpen, useConsoleOpenRequest } from "../client/open-link";
import { consoleProjectsVolatileNote, linkConsoleProject, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";
import ConsoleProjectProblemAlert from "./console-project-problem.vue";
import ConsoleProjectToken from "./console-project-token.vue";

const open = defineModel<boolean>("open", { required: true });
const persistent = useConsoleProjects().persistent;
const router = useRouter();

// An `/open` link of a project that this browser did not link fills in its URL.
const openRequest = useConsoleOpenRequest();
const url = ref(openRequest.value?.target.url ?? "");
const busy = ref(false);
const problem = shallowRef<ConsoleProjectProblem>();
// After the project asks for a token, the dialog shows the token step for that project.
const tokenStep = shallowRef<{ target: ConsoleProjectTarget, rejected: boolean }>();
// One object per answer, so the token form can tell a new answer from a render.
const tokenProblem = computed<ConsoleProjectProblem | undefined>(() => problem.value ?? (tokenStep.value?.rejected
  ? { title: "The token is not correct", message: consoleTokenRefused(consoleProjectHost(tokenStep.value.target)) }
  : undefined));
// A touch screen keeps its keyboard closed until the person taps a field. There the dialog itself takes focus, so a
// screen reader starts inside it and no button shows a focus ring.
const autofocus = !("ontouchstart" in window);
const content = autofocus ? {} : {
  onOpenAutoFocus: (event: Event) => {
    event.preventDefault();
    if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true });
  },
};

// The check that runs, so closing the dialog can drop its answer.
let check: AbortController | undefined;

watch(open, (value) => {
  if (value) {
    if (openRequest.value) url.value = openRequest.value.target.url;
    return;
  }
  check?.abort();
  check = undefined;
  cancelConsoleOpen();
  url.value = "";
  problem.value = undefined;
  tokenStep.value = undefined;
  busy.value = false;
});

watch(url, () => {
  problem.value = undefined;
});

async function link(token?: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  // The answer to the last token does not describe this one.
  if (tokenStep.value?.rejected) tokenStep.value = { target: tokenStep.value.target, rejected: false };
  const current = check = new AbortController();
  try {
    const result = await linkConsoleProject(tokenStep.value?.target.url ?? url.value, token, current.signal);
    if (current.signal.aborted) return;
    if (result.kind === "linked") {
      // The first project opens in place, so the dialog closes first.
      open.value = false;
      if (!finishConsoleOpen(result.project, path => { void router.push(path); })) switchConsoleProject(result.project.id);
      return;
    }
    if (result.kind === "token") tokenStep.value = { target: result.target, rejected: result.rejected };
    else problem.value = result.problem;
    busy.value = false;
  }
  catch {
    if (current.signal.aborted) return;
    problem.value = { title: "Could not link the project", message: "The check stopped. Try again." };
    busy.value = false;
  }
}

function back(): void {
  tokenStep.value = undefined;
  problem.value = undefined;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="tokenStep ? 'Enter the Console token' : 'Link project'"
    :content="content"
    :ui="{ content: 'vitehub-project-dialog sm:max-w-[440px]', title: 'pe-8 text-pretty [overflow-wrap:anywhere]', description: 'text-pretty [overflow-wrap:anywhere] pointer-coarse:mt-3' }"
  >
    <template #description>
      <template v-if="tokenStep">{{ consoleProjectHost(tokenStep.target) }} uses <code class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] text-highlighted box-decoration-clone">auth: "token"</code>.</template>
      <template v-else>Open a ViteHub app in this Console. The app must list this Console in <code class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] text-highlighted box-decoration-clone">console.origins</code>.</template>
    </template>
    <template #body>
      <div v-if="tokenStep" class="grid gap-3">
        <ConsoleProjectToken
          :busy="busy"
          :problem="tokenProblem"
          @submit="link"
        />
        <UButton color="neutral" variant="link" size="sm" class="justify-self-start px-0" icon="i-lucide-arrow-left" label="Use another URL" :disabled="busy" @click="back" />
      </div>
      <form v-else class="grid gap-4" novalidate @submit.prevent="link()">
        <UFormField
          label="Project URL"
          name="url"
          description="The app origin, with its base path if it has one."
          :error="problem ? true : undefined"
          :ui="{ error: 'mt-3' }"
        >
          <!-- Read-only, not disabled, while the check runs, so the field keeps focus for the next try. -->
          <UInput
            v-model="url"
            type="url"
            inputmode="url"
            autocomplete="url"
            spellcheck="false"
            placeholder="https://app.example.com"
            class="w-full"
            :autofocus="autofocus"
            :readonly="busy"
          />
          <template v-if="problem" #error>
            <ConsoleProjectProblemAlert :problem="problem" />
          </template>
        </UFormField>
        <UButton type="submit" block :loading="busy" :label="busy ? 'Checking…' : 'Continue'" />
        <p v-if="!persistent" class="text-xs text-pretty text-muted">{{ consoleProjectsVolatileNote }}</p>
      </form>
    </template>
  </UModal>
</template>

<style>
.vitehub-project-dialog :is(button, a[href]):focus-visible {
  outline-offset: 2px;
}

@media (pointer: coarse) {
  .vitehub-project-dialog :is(button:not([role="checkbox"], [role="radio"]), input) {
    min-height: 44px;
  }

  /* The tap area grows around the 28px button, so the X stays in line with the title. */
  .vitehub-project-dialog [data-slot="close"] {
    justify-content: center;
    margin: -8px;
    min-width: 44px;
  }
}
</style>
