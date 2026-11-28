<script setup lang="ts">
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle, CopyButton } from "@vite-hub/ui";
import { computed, ref, shallowRef, watch } from "vue";

import type { ConsoleAccountProject } from "../client/account";
import { appLinkPrompt, appVariableLine, hostedCommentsPrompt, hostedCommentsScript, repositoryPattern } from "../client/link-prompts";
import { registerAccountProject, showLinkedAccountProject, useConsoleProjects } from "../client/project-session";
import { useConsoleToast } from "../client/toast";
import ConsoleAccountSnippet from "./console-account-snippet.vue";

/**
 * Link an app or a site to the active team of an `account` Console. The Console server makes the token. The dialog
 * then shows the script tag of a site, or the variable of an app, with a prompt for a coding agent. When the dialog
 * closes, the Console opens the new project.
 */
const open = defineModel<boolean>("open", { required: true });
/** The app URL that the form starts with, such as the app of a `/_vitehub` link. */
const props = defineProps<{ url?: string }>();
const { pageOrigin } = useConsoleProjects();
const toast = useConsoleToast();
const url = ref("");
const label = ref("");
const repo = ref("");
const commentsOnly = shallowRef(false);
const busy = ref(false);
const problem = ref<string>();
const linked = shallowRef<ConsoleAccountProject>();

const site = computed(() => linked.value?.publicKey === null);
const code = computed(() => {
  if (!linked.value) return "";
  return site.value ? hostedCommentsScript(pageOrigin, linked.value.id, repo.value) : appVariableLine(linked.value);
});
const prompt = computed(() => {
  if (!linked.value) return "";
  return site.value ? hostedCommentsPrompt(linked.value.url, code.value) : appLinkPrompt(linked.value.url, code.value);
});
const title = computed(() => {
  if (!linked.value) return "Link an app";
  return site.value ? "Site registered" : "App linked";
});
const description = computed(() => {
  if (!linked.value) return "Enter the URL of your deployed app or site.";
  return site.value
    ? "Add this script to the <head> of the pages you want to review, or copy the prompt for your coding agent."
    : "Set this variable on the app and deploy it again, or copy the prompt for your coding agent.";
});

watch(open, (value) => {
  if (value) {
    url.value = props.url ?? "";
    return;
  }
  const project = linked.value;
  url.value = "";
  label.value = "";
  repo.value = "";
  commentsOnly.value = false;
  problem.value = undefined;
  busy.value = false;
  linked.value = undefined;
  if (project) showLinkedAccountProject(project.id);
});

async function link(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  try {
    linked.value = await registerAccountProject(url.value, label.value, commentsOnly.value ? "site" : undefined);
  }
  catch (error) {
    problem.value = error instanceof Error ? error.message : "Try again.";
  }
  busy.value = false;
}

function copyFailed(): void {
  toast.show({ title: "The browser blocked the clipboard. Select the text and copy it." });
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description" :ui="{ content: 'sm:max-w-[480px]' }">
    <template #body>
      <div v-if="linked" class="grid gap-3">
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle>{{ site ? "Hosted Comments script" : "Environment variable" }}</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton :value="code" :aria-label="site ? 'Copy the script' : 'Copy the variable'" color="neutral" @error="copyFailed" />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap class="break-all text-[13px] text-highlighted">{{ code }}</CodeBlockContent>
        </CodeBlock>
        <p v-if="site" class="text-sm text-pretty text-muted">The page at {{ linked.url }} completes the sign-in, so it needs the script too.</p>
        <p v-else class="text-sm text-pretty text-muted">The app also needs <code class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] whitespace-nowrap text-highlighted">console: true</code> in its config.</p>
      </div>
      <form v-else id="vitehub-account-link" class="grid gap-4" @submit.prevent="link">
        <UCheckbox v-model="commentsOnly" label="Hosted Comments only" description="Use a browser script to add page review." />
        <ConsoleAccountSnippet v-if="!commentsOnly" />
        <UFormField label="App URL" name="url" required :error="problem" :ui="{ error: problem ? undefined : 'mt-0' }">
          <!-- Nuxt UI renders the error without a live region, so the message announces itself here. -->
          <template #error="{ error }">
            <span role="alert">{{ error }}</span>
          </template>
          <UInput v-model="url" required type="url" inputmode="url" autocomplete="url" placeholder="https://app.example.com" class="w-full" autofocus />
        </UFormField>
        <UFormField label="Name" name="label" hint="Optional">
          <UInput v-model="label" class="w-full" />
        </UFormField>
        <UFormField v-if="commentsOnly" label="GitHub repository" name="repo" hint="Optional">
          <UInput v-model="repo" :pattern="repositoryPattern" placeholder="owner/name" autocomplete="off" spellcheck="false" class="w-full" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div v-if="linked" class="flex w-full justify-end gap-2">
        <CopyButton :value="prompt" color="neutral" variant="outline" label="Copy prompt" @error="copyFailed" />
        <UButton :label="site ? 'Open site' : 'Open app'" @click="open = false" />
      </div>
      <div v-else class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="vitehub-account-link" :label="commentsOnly ? 'Register site' : 'Link app'" :loading="busy" />
      </div>
    </template>
  </UModal>
</template>
