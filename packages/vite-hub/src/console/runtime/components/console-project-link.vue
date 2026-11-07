<script setup lang="ts">
import { ref, shallowRef, watch } from "vue";

import type { ConsoleProjectProblem } from "../client/project-link";
import { consoleTokenRefused } from "../client/project-link";
import type { ConsoleProjectTarget } from "../client/projects";
import { consoleProjectsVolatileNote, linkConsoleProject, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";
import ConsoleProjectOAuth from "./console-project-oauth.vue";
import ConsoleProjectToken from "./console-project-token.vue";

const open = defineModel<boolean>("open", { required: true });
const persistent = useConsoleProjects().persistent;

const url = ref("");
const busy = ref(false);
const problem = shallowRef<ConsoleProjectProblem>();
// After the project asks for a token, the dialog shows the token step for that project.
const tokenStep = shallowRef<{ target: ConsoleProjectTarget, rejected: boolean }>();
// A project with `auth: "app"` signs the Console in on its own sign-in page.
const oauthStep = shallowRef<{ target: ConsoleProjectTarget, resourceMetadata: string }>();
const autofocus = !("ontouchstart" in window);

watch(open, (value) => {
  if (value) return;
  url.value = "";
  problem.value = undefined;
  tokenStep.value = undefined;
  oauthStep.value = undefined;
  busy.value = false;
});

watch(url, () => {
  problem.value = undefined;
});

async function link(token?: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  try {
    const result = await linkConsoleProject(tokenStep.value?.target.url ?? url.value, token);
    if (result.kind === "linked") {
      // The first project opens in place, so the dialog closes first.
      open.value = false;
      switchConsoleProject(result.project.id);
      return;
    }
    if (result.kind === "token") tokenStep.value = { target: result.target, rejected: result.rejected };
    else if (result.kind === "oauth") oauthStep.value = { target: result.target, resourceMetadata: result.resourceMetadata };
    else problem.value = result.problem;
    busy.value = false;
  }
  catch {
    problem.value = { title: "Could not link the project", message: "The check stopped. Try again." };
    busy.value = false;
  }
}

function back(): void {
  tokenStep.value = undefined;
  oauthStep.value = undefined;
  problem.value = undefined;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="oauthStep ? `Sign in to ${consoleProjectHost(oauthStep.target)}` : tokenStep ? `Enter the Console token for ${consoleProjectHost(tokenStep.target)}` : 'Link project'"
    :description="oauthStep ? 'This project uses the sign-in of the app.' : tokenStep ? 'The project uses auth: &quot;token&quot;.' : 'Open a ViteHub app in this Console. The app must list this Console in console.origins.'"
    :dismissible="!busy"
    :ui="{ content: 'sm:max-w-[440px]' }"
  >
    <template #body>
      <div v-if="oauthStep" class="grid gap-3">
        <ConsoleProjectOAuth :target="oauthStep.target" :resource-metadata="oauthStep.resourceMetadata" />
        <UButton color="neutral" variant="link" size="sm" class="justify-self-start px-0" icon="i-lucide-arrow-left" label="Use another URL" @click="back" />
      </div>
      <div v-else-if="tokenStep" class="grid gap-3">
        <ConsoleProjectToken
          :busy="busy"
          :error="problem?.message ?? (tokenStep.rejected ? consoleTokenRefused(consoleProjectHost(tokenStep.target)) : undefined)"
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
        >
          <UInput
            v-model="url"
            type="url"
            inputmode="url"
            autocomplete="url"
            spellcheck="false"
            placeholder="https://app.example.com"
            class="w-full"
            :autofocus="autofocus"
            :disabled="busy"
            :aria-describedby="problem ? 'vitehub-project-link-problem' : undefined"
          />
        </UFormField>
        <div v-if="problem" id="vitehub-project-link-problem" role="alert" class="flex gap-2 text-sm">
          <UIcon name="i-lucide-circle-alert" class="mt-0.5 size-4 shrink-0 text-error" aria-hidden="true" />
          <div class="grid gap-0.5">
            <p class="font-medium text-highlighted">{{ problem.title }}</p>
            <p class="text-pretty text-muted">{{ problem.message }}</p>
          </div>
        </div>
        <UButton type="submit" block :loading="busy" :label="busy ? 'Checking…' : 'Continue'" />
        <p v-if="!persistent" class="text-xs text-pretty text-muted">{{ consoleProjectsVolatileNote }}</p>
      </form>
    </template>
  </UModal>
</template>
