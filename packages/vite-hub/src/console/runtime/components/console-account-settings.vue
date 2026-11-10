<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";

import type { ConsolePasskey } from "../client/account";
import { addConsolePasskey, deleteConsolePasskey, linkConsoleGitHub, listConsolePasskeys, listConsoleSignInProviders, loadConsoleSignInMethods, renameConsoleAccount } from "../client/account";
import { reloadConsoleAccount, useConsoleProjects } from "../client/project-session";
import { useConsoleToast } from "../client/toast";

/** The account settings of an `account` Console: the name, GitHub sign-in, and passkeys. */
const projects = useConsoleProjects();
const toast = useConsoleToast();
const account = computed(() => projects.account.value);
const name = ref(account.value?.user.name ?? "");
const saving = ref(false);
const passkeys = shallowRef<ConsolePasskey[]>();
const providers = shallowRef<string[]>();
const githubAvailable = ref(false);
const busy = ref<string>();
// The supported check is synchronous, so the passkey button never flashes.
const passkeySupport = typeof window.PublicKeyCredential === "function";

const github = computed(() => providers.value?.includes("github") ?? false);

async function load(): Promise<void> {
  const [keys, linked, methods] = await Promise.all([
    listConsolePasskeys().catch(() => []),
    listConsoleSignInProviders().catch(() => []),
    loadConsoleSignInMethods(),
  ]);
  passkeys.value = keys;
  providers.value = linked;
  githubAvailable.value = methods.github;
}

onMounted(load);

async function run(id: string, action: () => Promise<void>, done?: string): Promise<void> {
  if (busy.value) return;
  busy.value = id;
  try {
    await action();
    if (done) toast.show({ title: done });
    await load();
  }
  catch (error) {
    // A person who closed the browser's passkey sheet changed nothing.
    if (!(error instanceof DOMException && error.name === "NotAllowedError")) toast.show({ title: error instanceof Error ? error.message : "Try again." });
  }
  busy.value = undefined;
}

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    await renameConsoleAccount(name.value);
    reloadConsoleAccount();
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "Try again." });
    saving.value = false;
  }
}

function created(value: string | undefined): string {
  return value ? `Added ${new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "Passkey";
}
</script>

<template>
  <div class="grid max-w-2xl gap-8">
    <header class="grid gap-1">
      <h1 class="text-xl font-semibold text-highlighted">Settings</h1>
      <p class="text-sm text-pretty text-muted">Your name and the ways you sign in to this Console.</p>
    </header>

    <section class="grid gap-2" aria-labelledby="vitehub-settings-name">
      <h2 id="vitehub-settings-name" class="text-sm font-semibold text-highlighted">Name</h2>
      <form class="flex flex-wrap gap-2" @submit.prevent="save">
        <UInput v-model="name" autocomplete="name" aria-label="Name" required class="min-w-56 flex-1" />
        <UButton type="submit" color="neutral" variant="outline" label="Save" :loading="saving" :disabled="name.trim() === account?.user.name" />
      </form>
      <p class="text-xs text-dimmed">Your team sees this name.</p>
    </section>

    <section class="grid gap-2" aria-labelledby="vitehub-settings-sign-in">
      <h2 id="vitehub-settings-sign-in" class="text-sm font-semibold text-highlighted">Sign-in methods</h2>
      <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default">
        <li v-if="githubAvailable || github" class="flex items-center gap-3 px-3.5 py-2.5">
          <UIcon name="i-lucide-github" class="size-4 shrink-0 text-muted" />
          <span class="grid min-w-0 flex-1">
            <span class="text-sm font-medium text-highlighted">GitHub</span>
            <span class="text-xs text-dimmed">{{ github ? "Connected" : "Sign in with GitHub, and accept invitations sent to its email." }}</span>
          </span>
          <UButton v-if="providers && !github" size="sm" color="neutral" variant="outline" label="Connect" :loading="busy === 'github'" @click="run('github', () => linkConsoleGitHub(`${projects.pageOrigin}/settings`))" />
        </li>
        <template v-if="!passkeys">
          <li class="flex items-center gap-3 px-3.5 py-2.5">
            <USkeleton class="size-4" />
            <USkeleton class="h-3.5 w-32" />
          </li>
        </template>
        <li v-for="passkey in passkeys ?? []" :key="passkey.id" class="flex items-center gap-3 px-3.5 py-2.5">
          <UIcon name="i-lucide-key-round" class="size-4 shrink-0 text-muted" />
          <span class="grid min-w-0 flex-1">
            <span class="truncate text-sm font-medium text-highlighted">{{ passkey.name || "Passkey" }}</span>
            <span class="text-xs text-dimmed">{{ created(passkey.createdAt) }}</span>
          </span>
          <UTooltip v-if="(passkeys?.length ?? 0) > 1 || github" text="Remove passkey">
            <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" :aria-label="`Remove ${passkey.name || 'passkey'}`" :loading="busy === passkey.id" @click="run(passkey.id, () => deleteConsolePasskey(passkey.id), 'Passkey removed')" />
          </UTooltip>
        </li>
      </ul>
      <UButton v-if="passkeySupport" class="justify-self-start" color="neutral" variant="outline" icon="i-lucide-plus" label="Add a passkey" :loading="busy === 'passkey'" @click="run('passkey', addConsolePasskey, 'Passkey added')" />
      <p class="text-xs text-dimmed">The Console keeps at least one way to sign in, so the last one has no Remove button.</p>
    </section>
  </div>
</template>
