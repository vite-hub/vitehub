<script setup lang="ts">
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "@vite-hub/ui";
import { computed, ref } from "vue";

import { useConsoleProjects } from "../client/project-session";
import { grantSummary, inviteHostedCommentsGuest, readHostedCommentsAccess, revokeHostedCommentsAccess } from "../client/site-access";
import { useConsoleToast } from "../client/toast";

const props = defineProps<{ projectId: string }>();
const { pageOrigin } = useConsoleProjects();
const toast = useConsoleToast();
const code = computed(() => `<script type="module" src="${pageOrigin}/hosted-comments.js" data-vitehub-comments="${props.projectId}"><${"/script"}>`);
const access = ref<Awaited<ReturnType<typeof readHostedCommentsAccess>>>();
const name = ref("");
const permission = ref("write");
const days = ref("7");
const busy = ref(false);
const problem = ref("");
const inviteUrl = ref("");
const permissions = [
  { label: "Read comments", value: "read" },
  { label: "Write comments", value: "write" },
  { label: "Write and resolve", value: "resolve" },
];
const lifetimes = [{ label: "1 day", value: "1" }, { label: "7 days", value: "7" }, { label: "30 days", value: "30" }];

async function run(action?: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = "";
  try {
    await action?.();
    access.value = await readHostedCommentsAccess(props.projectId);
  }
  catch (error) {
    problem.value = error instanceof Error ? error.message : "The Console did not answer. Try again.";
  }
  finally {
    busy.value = false;
  }
}

async function invite(): Promise<void> {
  await run(async () => {
    const roles = permission.value === "resolve" ? ["comments-write", "comments-resolve"] : [`comments-${permission.value}`];
    const answer = await inviteHostedCommentsGuest(props.projectId, { name: name.value.trim(), grants: roles, expiresInDays: Number(days.value) });
    inviteUrl.value = answer.url;
    name.value = "";
  });
}

function opened(event: Event): void {
  if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open) void run();
}
</script>

<template>
  <div class="grid gap-3">
    <p class="text-sm text-pretty text-muted">Add this script to the registered page and the pages you want to review. The registered page completes sign-in.</p>
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>Hosted Comments script</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton :value="code" aria-label="Copy the Hosted Comments script" color="neutral" @error="toast.error('The browser blocked the clipboard. Select the script and copy it.')" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap class="break-all text-[13px] text-highlighted">{{ code }}</CodeBlockContent>
    </CodeBlock>
    <details class="grid gap-3" @toggle="opened">
      <summary class="cursor-pointer text-sm font-medium text-highlighted">Guest access</summary>
      <form class="mt-3 grid gap-3" @submit.prevent="invite">
        <div class="flex flex-wrap items-end gap-2">
          <UFormField label="Guest name" required>
            <UInput v-model="name" maxlength="64" required />
          </UFormField>
          <UFormField label="Permission">
            <USelect v-model="permission" :items="permissions" />
          </UFormField>
          <UFormField label="Expires in">
            <USelect v-model="days" :items="lifetimes" />
          </UFormField>
          <UButton label="Create invite" type="submit" :disabled="busy || !name.trim()" />
        </div>
        <p v-if="problem" class="text-sm text-error" role="alert">{{ problem }}</p>
        <div v-if="inviteUrl" class="flex items-end gap-2">
          <UFormField class="min-w-0 flex-1" label="One-time invite link">
            <UInput class="w-full" :model-value="inviteUrl" readonly />
          </UFormField>
          <CodeBlockCopyButton :value="inviteUrl" aria-label="Copy invite link" color="neutral" />
        </div>
      </form>
      <ul v-if="access" class="mt-3 divide-y divide-default">
        <li v-for="item in access.invites" :key="item.id" class="flex items-center justify-between gap-2 py-2 text-sm">
          <span>{{ item.name }} · Open invite · {{ grantSummary("guest", item.grants, access.grants) }}</span>
          <UButton label="Revoke" :aria-label="`Revoke the invite for ${item.name}`" color="neutral" variant="ghost" size="xs" :disabled="busy" @click="run(() => revokeHostedCommentsAccess(projectId, 'invites', item.id))" />
        </li>
        <li v-for="item in access.sessions" :key="item.id" class="flex items-center justify-between gap-2 py-2 text-sm">
          <span>{{ item.person.name }} · {{ item.device }} · {{ grantSummary("guest", item.grants, access.grants) }}</span>
          <UButton label="Revoke" :aria-label="`Revoke access for ${item.person.name}`" color="neutral" variant="ghost" size="xs" :disabled="busy" @click="run(() => revokeHostedCommentsAccess(projectId, 'sessions', item.id))" />
        </li>
      </ul>
    </details>
  </div>
</template>
