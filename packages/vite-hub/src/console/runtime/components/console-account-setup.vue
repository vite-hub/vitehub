<script setup lang="ts">
import { computed, ref } from "vue";

import type { ConsoleAccountProject } from "../client/account";
import { openConsoleProject } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";

/**
 * The step after linking a project to an `account` Console: the app must keep the hash of its token. The Console
 * shows the variable, and checks the project again on request.
 */
const props = defineProps<{ project: ConsoleAccountProject }>();

const busy = ref(false);
const copied = ref(false);
const host = computed(() => consoleProjectHost(props.project));
const line = computed(() => `${props.project.tokenVariable}=${props.project.tokenSha256}`);

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(line.value);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}

async function check(): Promise<void> {
  busy.value = true;
  await openConsoleProject().catch(() => undefined);
  busy.value = false;
}
</script>

<template>
  <div class="grid gap-1.5">
    <h1 class="vitehub-project-gate__title">Connect {{ project.label || host }}</h1>
    <p class="vitehub-project-gate__text">
      Set this variable on {{ host }} and deploy it. The app needs <code class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] text-highlighted">console: { auth: "token" }</code>. The Console keeps the token, and the app keeps only its SHA-256.
    </p>
  </div>
  <div class="grid min-w-0 gap-1 rounded-md border border-default bg-elevated/50 py-2 ps-3 pe-1.5">
    <div class="flex min-w-0 items-center justify-between gap-2">
      <code class="min-w-0 truncate font-mono text-[12px] font-medium text-highlighted">{{ project.tokenVariable }}</code>
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        :aria-label="copied ? 'Copied' : 'Copy the variable and its value'"
        @click="copy"
      />
    </div>
    <code class="break-all pe-1.5 font-mono text-[12px] text-muted">{{ project.tokenSha256 }}</code>
  </div>
  <UButton icon="i-lucide-refresh-cw" label="Check again" class="justify-self-start" :loading="busy" @click="check" />
</template>
