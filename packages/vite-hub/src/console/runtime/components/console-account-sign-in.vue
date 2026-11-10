<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";

import type { ConsoleSignInMethods } from "../client/account";
import { acceptConsoleInvitation, loadConsoleSignInMethods, signInWithGitHub, signInWithPasskey, signUpWithPasskey } from "../client/account";
import { reloadConsoleAccount, useConsoleProjects } from "../client/project-session";

/**
 * The sign-in page of an `account` Console: GitHub, a passkey, or a new account with a passkey. On an `/invite/<id>`
 * page, a signed-in person accepts the invitation instead.
 */
const props = defineProps<{ invitation?: string }>();

const projects = useConsoleProjects();
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

/** Run a sign-in step. After it, the Console loads again: the invitation page shows Accept, other pages the projects. */
async function run(kind: NonNullable<typeof busy.value>, action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = kind;
  problem.value = undefined;
  try {
    await action();
    // The browser is on its way to GitHub.
    if (kind === "github") return;
    if (props.invitation && kind !== "accept") window.location.reload();
    else reloadConsoleAccount();
  }
  catch (error) {
    // A person who closed the browser's passkey sheet chose not to sign in. That is not an error to show.
    if (!(error instanceof DOMException && error.name === "NotAllowedError")) problem.value = error instanceof Error ? error.message : "Try again.";
    busy.value = undefined;
  }
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
      <p class="vitehub-project-gate__text">You are signed in as {{ account.user.name }}. Accept the invitation to open the projects of its team.</p>
    </div>
    <div class="flex flex-wrap gap-2">
      <UButton label="Accept invitation" :loading="busy === 'accept'" @click="run('accept', () => acceptConsoleInvitation(invitation!))" />
      <UButton color="neutral" variant="ghost" label="Not now" @click="reloadConsoleAccount" />
    </div>
  </template>

  <template v-else>
    <div class="grid gap-1.5">
      <h1 class="vitehub-project-gate__title">{{ invitation ? "Sign in to join the team" : "Sign in to ViteHub Console" }}</h1>
      <p class="vitehub-project-gate__text">Link your ViteHub apps to a team, and open them from any browser.</p>
    </div>

    <div v-if="!creating" class="grid gap-2 sm:max-w-80">
      <UButton
        v-if="methods?.github"
        icon="i-lucide-github"
        label="Continue with GitHub"
        block
        :loading="busy === 'github'"
        @click="run('github', () => signInWithGitHub(`${projects.pageOrigin}${invitationPath ?? '/'}`))"
      />
      <UButton
        v-if="passkeys"
        :color="methods?.github ? 'neutral' : 'primary'"
        :variant="methods?.github ? 'outline' : 'solid'"
        icon="i-lucide-key-round"
        label="Sign in with a passkey"
        block
        :loading="busy === 'passkey'"
        @click="run('passkey', signInWithPasskey)"
      />
      <UButton v-if="passkeys" color="neutral" variant="ghost" label="Create an account with a passkey" block @click="creating = true" />
      <p v-if="!passkeys && !methods?.github" class="vitehub-project-gate__text">This browser has no passkeys. Use a current browser to sign in.</p>
    </div>

    <form v-else class="grid gap-3 sm:max-w-80" @submit.prevent="create">
      <UFormField label="Your name" name="name" help="The Console shows it to your team.">
        <UInput v-model="name" autocomplete="name" autofocus class="w-full" />
      </UFormField>
      <div class="flex flex-wrap gap-2">
        <UButton type="submit" icon="i-lucide-key-round" label="Create passkey" :loading="busy === 'create'" />
        <UButton color="neutral" variant="ghost" label="Back" @click="creating = false" />
      </div>
    </form>

    <p v-if="problem" role="alert" class="text-[13px] text-error">{{ problem }}</p>
  </template>
</template>
