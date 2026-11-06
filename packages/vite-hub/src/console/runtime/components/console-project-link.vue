<script setup lang="ts">
import { ref, shallowRef, watch } from "vue";

import type { ConsoleProjectProblem } from "../client/project-link";
import type { ConsoleProjectTarget } from "../client/projects";
import { cancelConsoleOpen, finishConsoleOpen, useConsoleOpenRequest } from "../client/open-link";
import { createConsolePendingLink, linkConsoleProject, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";
import ConsoleProjectToken from "./console-project-token.vue";

const open = defineModel<boolean>("open", { required: true });
const projects = useConsoleProjects();

// An `/open` link of a project that this browser did not link fills in its URL.
const openRequest = useConsoleOpenRequest();
const url = ref(openRequest.value?.target.url ?? "");
const busy = ref(false);
const newProject = ref(false);
const command = ref("");
const copied = ref(false);
const problem = shallowRef<ConsoleProjectProblem>();
// After the project asks for a token, the dialog shows the token step for that project.
const tokenStep = shallowRef<{ target: ConsoleProjectTarget, rejected: boolean }>();
const autofocus = !("ontouchstart" in window);

watch(open, (value) => {
  if (value) {
    if (openRequest.value) url.value = openRequest.value.target.url;
    return;
  }
  cancelConsoleOpen();
  url.value = "";
  problem.value = undefined;
  tokenStep.value = undefined;
  newProject.value = false;
  command.value = "";
  copied.value = false;
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
      if (!finishConsoleOpen(result.project)) switchConsoleProject(result.project.id);
      return;
    }
    if (result.kind === "token") tokenStep.value = { target: result.target, rejected: result.rejected };
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
  problem.value = undefined;
  newProject.value = false;
  command.value = "";
  copied.value = false;
}

async function createLink(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  newProject.value = true;
  problem.value = undefined;
  try {
    const ticket = await createConsolePendingLink();
    if (open.value) command.value = `vite-hub init --console ${ticket.pendingId}:sha256:${ticket.verifier}`;
  }
  catch {
    problem.value = { title: "Could not make a link", message: "Allow this Console to use browser storage, then try again." };
  }
  busy.value = false;
}

async function copyCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
  }
  catch {
    // The command stays visible to select and copy by hand.
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="newProject ? 'Link a new project' : tokenStep ? `Enter the Console token for ${consoleProjectHost(tokenStep.target)}` : 'Link project'"
    :description="newProject ? 'Run this command in your terminal, then open the link it prints in this browser profile.' : tokenStep ? 'The project uses auth: &quot;token&quot;.' : 'Open a ViteHub app in this Console. The app must list this Console in console.origins.'"
    :dismissible="!busy"
    :ui="{ content: 'sm:max-w-[440px]' }"
  >
    <template #body>
      <div v-if="newProject" class="grid gap-3">
        <template v-if="command">
          <pre class="overflow-x-auto rounded-md border border-default p-3 text-xs"><code>{{ command }}</code></pre>
          <UButton color="neutral" variant="outline" :label="copied ? 'Copied' : 'Copy command'" @click="copyCommand" />
          <p class="text-sm text-muted">This command works once, for 24 hours. Check the app's host before you confirm its link.</p>
        </template>
        <div v-if="problem" role="alert" class="grid gap-1 text-sm">
          <p class="font-medium text-highlighted">{{ problem.title }}</p>
          <p class="text-muted">{{ problem.message }}</p>
          <UButton label="Try again" :loading="busy" @click="createLink" />
        </div>
        <p v-else-if="busy" role="status" class="text-sm text-muted">Making a link…</p>
        <UButton color="neutral" variant="link" size="sm" class="justify-self-start px-0" label="Use a project URL" :disabled="busy" @click="back" />
      </div>
      <div v-else-if="tokenStep" class="grid gap-3">
        <ConsoleProjectToken
          :busy="busy"
          :error="problem?.message ?? (tokenStep.rejected ? `${consoleProjectHost(tokenStep.target)} refused this token. Copy the current value of VITEHUB_CONSOLE_TOKEN from the server and try again.` : undefined)"
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
        <UButton v-if="projects.mode === 'hosted'" type="button" color="neutral" variant="outline" block label="Link a new project" :disabled="busy" @click="createLink" />
      </form>
    </template>
  </UModal>
</template>
