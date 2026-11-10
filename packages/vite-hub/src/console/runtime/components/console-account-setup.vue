<script setup lang="ts">
import { computed, ref } from "vue";

import type { ConsoleAccountAppStatus, ConsoleAccountProject } from "../client/account";
import { checkConsoleAccountProject } from "../client/account";
import { openAccountProject } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";
import ConsoleAccountUnlink from "./console-account-unlink.vue";

/**
 * The step after linking an app to an `account` Console: the app must keep the hash of its token. The page shows the
 * line to set, and asks the Console server to check the app again.
 */
const props = defineProps<{ project: ConsoleAccountProject }>();
const emit = defineEmits<{ checked: [status: ConsoleAccountAppStatus] }>();

const busy = ref(false);
const copyState = ref<"copied" | "failed">();
const result = ref<string>();
const unlinking = ref(false);
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
    emit("checked", answer.status);
    if (answer.status === "connected") {
      openAccountProject(props.project.id);
      return;
    }
    if (answer.status === "setup") result.value = `Checked at ${time}. ${host.value} does not accept the token yet. Set this variable, redeploy, and check again.`;
    else if (answer.status === "unreachable") result.value = `Checked at ${time}. The Console could not reach ${host.value}. Check the URL and that the app is deployed.`;
    else if (answer.code >= 500) result.value = `Checked at ${time}. ${host.value} returned a server error. Check its logs and try again.`;
    else result.value = `Checked at ${time}. ${host.value} is not set up for the Console yet. Add console: { auth: 'token' }, redeploy, and check again.`;
  }
  catch {
    result.value = `Checked at ${time}. The Console did not answer. Check your connection and try again.`;
  }
  busy.value = false;
}
</script>

<template>
  <div class="grid max-w-2xl gap-6">
    <p class="text-sm text-pretty text-muted">
      {{ host }} needs <code class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] whitespace-nowrap text-highlighted">console: { auth: 'token' }</code> in its config.
      Then add this environment variable to its deployment settings, redeploy, and check the connection.
    </p>

    <div class="grid gap-1.5">
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
      <span role="status" class="sr-only">{{ copyState === "copied" ? "Copied" : "" }}</span>
      <p v-if="copyState === 'failed'" role="alert" class="text-[13px] text-error">The browser blocked the clipboard. Select the line and copy it.</p>
    </div>

    <div class="grid gap-2">
      <div class="flex flex-wrap gap-2">
        <UButton icon="i-lucide-refresh-cw" label="Check connection" :loading="busy" @click="check" />
        <UButton color="neutral" variant="ghost" icon="i-lucide-unlink" :label="`Unlink ${name}`" @click="unlinking = true" />
      </div>
      <p role="status" class="text-[13px] leading-5 text-muted">{{ result }}</p>
    </div>

    <ConsoleAccountUnlink v-model:open="unlinking" :project-id="project.id" :name="name" />
  </div>
</template>
