<script setup lang="ts">
import { computed, ref } from "vue";

import type { ConsoleAccountProject } from "../client/account";
import { checkConsoleAccountProject } from "../client/account";
import { forgetConsoleProject, openAccountProject } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";

/**
 * The step after linking an app to an `account` Console: the app must keep the hash of its token. The page shows the
 * line to set, and asks the Console server to check the app again.
 */
const props = defineProps<{ project: ConsoleAccountProject }>();

const busy = ref(false);
const copyState = ref<"copied" | "failed">();
const result = ref<string>();
const host = computed(() => consoleProjectHost(props.project));
const name = computed(() => props.project.label || host.value);
const line = computed(() => `${props.project.tokenVariable}=${props.project.tokenSha256}`);

async function copy(): Promise<void> {
  copyState.value = await navigator.clipboard.writeText(line.value).then(() => "copied" as const, () => "failed" as const);
  setTimeout(() => { copyState.value = undefined; }, 3000);
}

async function check(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date());
  try {
    const answer = await checkConsoleAccountProject(props.project.id);
    if (answer.linked) {
      openAccountProject(props.project.id);
      return;
    }
    result.value = answer.status === 401 || answer.status === 500
      ? `Checked at ${time}. ${host.value} does not have this variable yet. Redeploy after you set it.`
      : `Checked at ${time}. ${host.value} answered ${answer.status}.`;
  }
  catch {
    result.value = `Checked at ${time}. The Console could not reach ${host.value}.`;
  }
  busy.value = false;
}
</script>

<template>
  <div class="grid max-w-2xl gap-6">
    <header class="grid gap-1">
      <h2 class="text-xl font-semibold text-balance text-highlighted">Connect {{ name }}</h2>
      <p class="text-sm text-pretty text-muted">Add this environment variable to the deployment settings of {{ host }}. Redeploy, then check the connection.</p>
    </header>

    <div class="flex min-w-0 items-start gap-2 rounded-lg border border-default bg-elevated/40 py-2.5 ps-3.5 pe-2">
      <code class="min-w-0 flex-1 font-mono text-[13px] leading-5 break-all text-highlighted">{{ line }}</code>
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        :icon="copyState === 'copied' ? 'i-lucide-check' : 'i-lucide-copy'"
        aria-label="Copy the variable"
        @click="copy"
      />
    </div>

    <p role="status" class="-mt-4 min-h-5 text-[13px] text-muted">
      <template v-if="copyState === 'copied'">Copied.</template>
      <template v-else-if="copyState === 'failed'">The browser blocked the clipboard. Select the line and copy it.</template>
    </p>

    <p class="text-[13px] leading-5 text-muted">
      The app also needs <code class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] whitespace-nowrap text-highlighted">console: { auth: 'token' }</code> in its config.
    </p>

    <div class="grid gap-2">
      <div class="flex flex-wrap gap-2">
        <UButton icon="i-lucide-refresh-cw" label="Check connection" :loading="busy" @click="check" />
        <UButton color="neutral" variant="ghost" icon="i-lucide-unlink" :label="`Unlink ${name}`" @click="forgetConsoleProject(project.id)" />
      </div>
      <p role="status" class="text-[13px] leading-5 text-muted">{{ result }}</p>
    </div>
  </div>
</template>
