<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef } from "vue";

import type { ConsoleSignInMethods } from "../client/account";
import { acceptConsoleInvitation, linkConsoleGitHub, loadConsoleSignInMethods, signInWithGitHub, signInWithPasskey, signUpWithPasskey } from "../client/account";
import { consoleSignInReturnPath, consoleSiteLink, finishConsoleSignIn, reloadConsoleAccount, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";

/**
 * The sign-in page of an `account` Console: GitHub, a passkey, or a new account with a passkey. On an `/invite/<id>`
 * page, a signed-in person accepts the invitation instead.
 */
const props = defineProps<{ invitation?: string }>();

const projects = useConsoleProjects();
// The app of a `/_vitehub` link, which the sign-in goes back to.
const siteHost = computed(() => {
  const site = consoleSiteLink(new URL(consoleSignInReturnPath(), "https://console.invalid").search);
  return site ? consoleProjectHost(site) : undefined;
});
const account = computed(() => projects.account.value);
const methods = shallowRef<ConsoleSignInMethods>();
const busy = ref<"github" | "passkey" | "create" | "accept">();
const problem = ref<string>();
const creating = ref(false);
const name = ref("");
// The supported check is synchronous, so the passkey buttons never flash.
const passkeys = typeof window.PublicKeyCredential === "function";

onMounted(async () => {
  methods.value = await loadConsoleSignInMethods();
});

/**
 * Run a sign-in step. After it, the Console loads again: the invitation page shows Accept, an `/open` link opens its
 * page, and other pages show the projects.
 */
async function run(kind: NonNullable<typeof busy.value>, action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = kind;
  problem.value = undefined;
  try {
    await action();
    // The browser is on its way to GitHub.
    if (kind === "github") return;
    if (props.invitation && kind !== "accept") window.location.reload();
    // A sign-in from an `/open` link opens that link again.
    else finishConsoleSignIn();
  }
  catch (error) {
    // A person who closed the browser's passkey sheet chose not to sign in. That is not an error to show.
    if (!(error instanceof DOMException && error.name === "NotAllowedError")) problem.value = error instanceof Error ? error.message : "Try again.";
    busy.value = undefined;
  }
}

// "Back" removes the form, so focus returns to the link that opened it.
const createLink = ref<HTMLButtonElement>();

function back(): void {
  creating.value = false;
  void nextTick(() => createLink.value?.focus());
}

function create(): void {
  void run("create", () => signUpWithPasskey(name.value));
}

const invitationPath = computed(() => props.invitation ? `/invite/${encodeURIComponent(props.invitation)}` : undefined);
</script>

<template>
  <template v-if="account && invitation">
    <div class="grid gap-1.5">
      <h1 class="vitehub-project-gate__title">Join a team</h1>
      <p v-if="account.hasEmail" class="vitehub-project-gate__text">You are signed in as {{ account.user.name }}. Accept the invitation to open the apps of its team.</p>
      <p v-else class="vitehub-project-gate__text">Invitations go to the email of a GitHub account, and {{ account.user.name }} signs in with a passkey only. Connect GitHub, and this page opens again to accept.</p>
    </div>
    <div class="flex flex-wrap gap-2">
      <UButton v-if="account.hasEmail" label="Accept invitation" :loading="busy === 'accept'" @click="run('accept', () => acceptConsoleInvitation(invitation!))" />
      <UButton v-else icon="i-lucide-github" label="Connect GitHub" :loading="busy === 'github'" @click="run('github', () => linkConsoleGitHub(`${projects.pageOrigin}${invitationPath}`))" />
      <UButton color="neutral" variant="ghost" label="Not now" @click="reloadConsoleAccount" />
    </div>
  </template>

  <template v-else>
    <div class="grid gap-1.5">
      <h1 class="text-xl/7 font-semibold text-balance text-highlighted">{{ creating ? "Create your account" : invitation ? "Sign in to join the team" : "Sign in to ViteHub Console" }}</h1>
      <p v-if="invitation" class="vitehub-project-gate__text">This invitation is for a GitHub account. Continue with GitHub to accept it.</p>
      <p v-else-if="siteHost" class="vitehub-project-gate__text">Then you go back to {{ siteHost }}, signed in with your tools.</p>
      <p v-else class="vitehub-project-gate__text">Open your team's ViteHub apps from any browser.</p>
    </div>

    <!-- The buttons wait for the sign-in methods in a reserved space, so GitHub does not push the passkey button down. -->
    <div v-if="!creating" class="grid min-h-[7.75rem] content-start gap-2" :aria-busy="!methods">
      <UButton
        v-if="methods?.github"
        icon="i-lucide-github"
        label="Continue with GitHub"
        block
        class="h-10"
        :loading="busy === 'github'"
        @click="run('github', () => signInWithGitHub(`${projects.pageOrigin}${invitationPath ?? consoleSignInReturnPath()}`))"
      />
      <UButton
        v-if="passkeys && methods"
        :color="methods?.github ? 'neutral' : 'primary'"
        :variant="methods?.github ? 'outline' : 'solid'"
        icon="i-lucide-key-round"
        label="Sign in with a passkey"
        block
        class="h-10"
        :loading="busy === 'passkey'"
        @click="run('passkey', signInWithPasskey)"
      />
      <!-- A new passkey account has no email, so it cannot accept an invitation. Invitation pages do not offer it. -->
      <p v-if="passkeys && methods && !invitation" class="mt-2 text-sm text-muted">
        New to ViteHub?
        <button ref="createLink" type="button" class="vitehub-account-sign-in__create" @click="creating = true">Create an account with a passkey</button>
      </p>
      <p v-if="methods && !passkeys && !methods.github" class="vitehub-project-gate__text">This browser has no passkeys. Use a current browser to sign in.</p>
    </div>

    <form v-else class="grid gap-3" @submit.prevent="create">
      <UFormField label="Your name" name="name" help="The Console shows it to your team.">
        <UInput v-model="name" autocomplete="name" autofocus class="w-full" />
      </UFormField>
      <div class="flex flex-wrap gap-2">
        <UButton type="submit" icon="i-lucide-key-round" label="Create passkey" class="h-10" :loading="busy === 'create'" />
        <UButton color="neutral" variant="ghost" label="Back" @click="back" />
      </div>
    </form>
  </template>

  <!-- Both branches report here, so a failed invitation also says why. -->
  <p v-if="problem" role="alert" class="text-[13px] text-error">{{ problem }}</p>
</template>

<style>
.vitehub-account-sign-in__create {
  border-radius: 0.125rem;
  color: var(--ui-text-highlighted);
  font-weight: 500;
  text-decoration: underline;
  text-decoration-color: var(--ui-border-accented);
  text-underline-offset: 0.2em;
}

.vitehub-account-sign-in__create:hover {
  text-decoration-color: currentColor;
}
</style>
