<script setup lang="ts">
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "@vite-hub/ui";
import { computed, ref } from "vue";

import type { ConsoleAccountAppStatus, ConsoleAccountProject } from "../client/account";
import { checkConsoleAccountProject } from "../client/account";
import { openAccountProject } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";
import { useConsoleToast } from "../client/toast";
import ConsoleAccountUnlink from "./console-account-unlink.vue";
import ConsoleHostedCommentsEmbed from "./console-hosted-comments-embed.vue";

const props = defineProps<{ project: ConsoleAccountProject, reason?: "missing" | "key" }>();
const emit = defineEmits<{ checked: [status: ConsoleAccountAppStatus] }>();

const toast = useConsoleToast();
const busy = ref(false);
const result = ref<string>();
const unlinking = ref(false);
const host = computed(() => consoleProjectHost(props.project));
const name = computed(() => props.project.label || host.value);
const line = computed(() => `${props.project.keyVariable}=${props.project.publicKey}`);

async function check(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date());
  try {
    const answer = await checkConsoleAccountProject(props.project.id);
    emit("checked", answer.status);
    if (answer.status === "connected") {
      openAccountProject(props.project.id);
      return;
    }
    if (answer.status === "setup") result.value = `Checked at ${time}. ${host.value} does not accept the signature yet. Set this variable, redeploy, and check again.`;
    else if (answer.status === "unreachable") result.value = `Checked at ${time}. The Console could not reach ${host.value}. Check the URL and that the app is deployed.`;
    else if (answer.code === 404) result.value = `Checked at ${time}. No ViteHub app answers at ${props.project.url}. Check that the app is deployed there and has console: true, then check again.`;
    else if (answer.code >= 500) result.value = `Checked at ${time}. ${host.value} returned a server error. Check its logs and try again.`;
    else result.value = `Checked at ${time}. ${host.value} is not set up for the Console yet. Add console: true, redeploy, and check again.`;
  }
  catch {
    result.value = `Checked at ${time}. The Console did not answer. Check your connection and try again.`;
  }
  busy.value = false;
}
</script>

<template>
  <div v-if="project.publicKey === null" class="grid max-w-2xl gap-6">
    <ConsoleHostedCommentsEmbed :project-id="project.id" />
    <div class="flex flex-wrap gap-2">
      <UButton icon="i-lucide-external-link" label="Open site" :to="`${project.url}?vitehub`" target="_blank" rel="noopener" />
      <UButton color="neutral" variant="ghost" icon="i-lucide-unlink" :label="`Unlink ${name}`" @click="unlinking = true" />
    </div>
  </div>
  <div v-else class="grid max-w-2xl gap-6">
    <p v-if="reason === 'missing'" class="text-sm text-pretty text-muted">
      No ViteHub app answers at {{ project.url }}. Check that the app is deployed at this address and that its config has <code class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] whitespace-nowrap text-highlighted">console: true</code>.
      Then add this environment variable to its deployment settings, redeploy, and check the connection.
    </p>
    <p v-else class="text-sm text-pretty text-muted">
      {{ host }} does not have the key of this link yet. Add this environment variable to its deployment settings, redeploy, and check the connection.
    </p>

    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>Environment variable</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton
            :value="line"
            aria-label="Copy the variable"
            color="neutral"
            @error="toast.show({ title: 'The browser blocked the clipboard. Select the line and copy it.' })"
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap class="break-all text-[13px] text-highlighted">{{ line }}</CodeBlockContent>
    </CodeBlock>

    <div class="grid gap-2">
      <div class="flex flex-wrap gap-2">
        <UButton icon="i-lucide-refresh-cw" label="Check connection" :loading="busy" @click="check" />
        <UButton color="neutral" variant="ghost" icon="i-lucide-unlink" :label="`Unlink ${name}`" @click="unlinking = true" />
      </div>
      <p role="status" class="text-[13px] leading-5 text-muted">{{ result }}</p>
    </div>
  </div>
  <ConsoleAccountUnlink v-model:open="unlinking" :project-id="project.id" :name="name" />
</template>
