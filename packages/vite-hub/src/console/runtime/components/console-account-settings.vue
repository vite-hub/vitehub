<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef } from "vue";

import type { ConsolePasskey } from "../client/account";
import { addConsolePasskey, deleteConsolePasskey, earlyConsoleSignInState, linkConsoleGitHub, loadConsoleSignInState, renameConsoleAccount } from "../client/account";
import { useConsoleProjects } from "../client/project-session";
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
const loadProblem = ref(false);
const removing = ref<ConsolePasskey>();
const removeBusy = ref(false);
const removeProblem = ref<string>();
// The supported check is synchronous, so the passkey button never flashes.
const passkeySupport = typeof window.PublicKeyCredential === "function";

const github = computed(() => providers.value?.includes("github") ?? false);
// The Console keeps one way to sign in. The last passkey of an account without GitHub has no Remove button.
const methodCount = computed(() => (passkeys.value?.length ?? 0) + (github.value ? 1 : 0));
const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Loads the sign-in methods. A failed load keeps the rows that the page shows, and says so. */
async function load(answer = loadConsoleSignInState()): Promise<void> {
  try {
    const state = await answer;
    passkeys.value = state.passkeys;
    providers.value = state.providers;
    githubAvailable.value = state.methods.github;
    loadProblem.value = false;
  }
  catch {
    loadProblem.value = true;
  }
}

// The link to this page starts the load when the pointer or the focus reaches it.
onMounted(() => load(earlyConsoleSignInState.take()));

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

async function removePasskey(): Promise<void> {
  const passkey = removing.value;
  if (!passkey || removeBusy.value) return;
  removeBusy.value = true;
  removeProblem.value = undefined;
  try {
    await deleteConsolePasskey(passkey.id);
    toast.show({ title: "Passkey removed" });
    removeBusy.value = false;
    removing.value = undefined;
    await load();
    // The removed row took its button along, so focus goes to the list heading once the dialog has closed.
    void nextTick(() => setTimeout(() => document.getElementById("vitehub-settings-sign-in")?.focus(), 300));
  }
  catch (error) {
    removeProblem.value = error instanceof Error ? error.message : "The passkey was not removed. Try again.";
    removeBusy.value = false;
  }
}

function closeRemove(): void {
  removing.value = undefined;
  removeProblem.value = undefined;
}

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    await renameConsoleAccount(name.value);
    // The page loads again where it is, so the new name in the field and the sidebar confirms the change.
    window.location.reload();
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "Try again." });
    saving.value = false;
  }
}

function added(value: string | undefined): string {
  return value ? `Added ${dateFormat.format(new Date(value))}` : "Added before dates were kept";
}
</script>

<template>
  <div class="grid max-w-2xl gap-10">
    <p class="text-sm text-pretty text-muted">Your name and the ways you sign in. They are the same in every team.</p>

    <section class="grid gap-3" aria-labelledby="vitehub-settings-name">
      <h2 id="vitehub-settings-name" class="text-sm font-semibold text-highlighted">Name</h2>
      <form class="grid gap-1.5" @submit.prevent="save">
        <div class="flex flex-wrap gap-2">
          <UInput v-model="name" autocomplete="name" aria-labelledby="vitehub-settings-name" aria-describedby="vitehub-settings-name-help" required class="min-w-0 flex-1 basis-56" />
          <UButton type="submit" color="neutral" variant="outline" label="Save" class="justify-center max-sm:w-full" :loading="saving" :disabled="name.trim() === account?.user.name" />
        </div>
        <p id="vitehub-settings-name-help" class="text-xs text-muted">People in your teams see this name.</p>
      </form>
    </section>

    <section class="grid gap-3" aria-labelledby="vitehub-settings-sign-in">
      <div class="flex items-center justify-between gap-2">
        <h2 id="vitehub-settings-sign-in" tabindex="-1" class="text-sm font-semibold text-highlighted outline-none">Sign-in methods</h2>
        <UButton v-if="passkeySupport" size="sm" color="neutral" variant="ghost" icon="i-lucide-plus" label="Add a passkey" :loading="busy === 'passkey'" @click="run('passkey', addConsolePasskey, 'Passkey added')" />
      </div>
      <ul class="vitehub-account-list">
        <li v-if="githubAvailable || github" class="vitehub-account-list__row">
          <UIcon name="i-lucide-github" class="vitehub-account-icon shrink-0 text-muted" aria-hidden="true" />
          <span class="grid min-w-0 flex-1">
            <span class="text-sm font-medium text-highlighted">GitHub</span>
            <span class="text-xs text-muted">{{ github ? "Connected" : "Sign in with GitHub, and accept invitations sent to its email." }}</span>
          </span>
          <UButton v-if="providers && !github" size="sm" color="neutral" variant="outline" label="Connect" :loading="busy === 'github'" @click="run('github', () => linkConsoleGitHub(`${projects.pageOrigin}/settings`))" />
        </li>
        <!-- Two rows, GitHub and a passkey, the list of most accounts. -->
        <template v-if="!passkeys && !loadProblem">
          <li v-for="index in 2" :key="index" class="vitehub-account-list__row" aria-hidden="true">
            <USkeleton class="vitehub-account-icon shrink-0" />
            <span class="grid flex-1 gap-1.5 py-0.5">
              <USkeleton class="h-3.5 w-24" />
              <USkeleton class="h-3 w-40" />
            </span>
          </li>
        </template>
        <li v-for="passkey in passkeys ?? []" :key="passkey.id" class="vitehub-account-list__row">
          <UIcon name="i-lucide-key-round" class="vitehub-account-icon shrink-0 text-muted" aria-hidden="true" />
          <span class="grid min-w-0 flex-1">
            <span class="truncate text-sm font-medium text-highlighted">Passkey</span>
            <span class="text-xs text-muted">{{ added(passkey.createdAt) }}{{ methodCount === 1 ? " · Only sign-in method" : "" }}</span>
          </span>
          <UTooltip v-if="methodCount > 1" text="Remove passkey">
            <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" :aria-label="`Remove the passkey ${added(passkey.createdAt).toLowerCase()}`" :loading="busy === passkey.id" @click="removing = passkey" />
          </UTooltip>
        </li>
      </ul>
      <UModal
        :open="removing !== undefined"
        title="Remove this passkey?"
        description="You can no longer sign in with it."
        :dismissible="!removeBusy"
        :close="{ disabled: removeBusy }"
        :ui="{ content: 'sm:max-w-[440px]' }"
        @update:open="(value: boolean) => { if (!value) closeRemove(); }"
      >
        <template v-if="removeProblem" #body>
          <p role="alert" class="text-[13px] text-error">{{ removeProblem }}</p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" label="Cancel" :disabled="removeBusy" @click="closeRemove" />
            <UButton color="error" label="Remove passkey" :loading="removeBusy" @click="removePasskey" />
          </div>
        </template>
      </UModal>
      <div v-if="loadProblem" role="alert" class="flex items-center gap-2 text-[13px] text-error">
        The sign-in methods did not load.
        <UButton size="xs" color="neutral" variant="ghost" label="Retry" @click="load()" />
      </div>
    </section>
  </div>
</template>
