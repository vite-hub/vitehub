<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";

import type { ConsoleTeamDetails } from "../client/account";
import { canManageConsoleProjects, cancelConsoleInvitation, inviteConsoleMember, loadConsoleTeam, removeConsoleMember, renameConsoleTeam } from "../client/account";
import { reloadConsoleAccount, useConsoleProjects } from "../client/project-session";
import { useConsoleToast } from "../client/toast";

/** The team page of an `account` Console: the members, the pending invitations, and the team name. */
const projects = useConsoleProjects();
const toast = useConsoleToast();
const account = computed(() => projects.account.value);
const team = computed(() => account.value?.teams.find(item => item.id === account.value?.teamId));
const manage = computed(() => account.value ? canManageConsoleProjects(account.value) : false);
const details = shallowRef<ConsoleTeamDetails>();
const loadProblem = ref<string>();

const email = ref("");
const role = ref<"member" | "admin">("member");
const inviting = ref(false);
const inviteProblem = ref<string>();
const name = ref(team.value?.name ?? "");
const renaming = ref(false);

async function load(): Promise<void> {
  try {
    details.value = await loadConsoleTeam();
    loadProblem.value = undefined;
  }
  catch (error) {
    loadProblem.value = error instanceof Error ? error.message : "The team did not load.";
  }
}

onMounted(load);

function initials(text: string): string {
  return text.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase();
}

function visibleEmail(value: string): string | undefined {
  return value.endsWith("@passkey.invalid") ? undefined : value;
}

async function invite(): Promise<void> {
  if (inviting.value) return;
  inviting.value = true;
  inviteProblem.value = undefined;
  try {
    const link = await inviteConsoleMember(email.value, role.value);
    await navigator.clipboard.writeText(link).catch(() => undefined);
    toast.show({ title: `Link copied. Send it to ${email.value}; it works for 48 hours.`, duration: 8_000 });
    email.value = "";
    await load();
  }
  catch (error) {
    inviteProblem.value = error instanceof Error ? error.message : "Try again.";
  }
  inviting.value = false;
}

async function run(action: () => Promise<void>, done: string): Promise<void> {
  try {
    await action();
    toast.show({ title: done });
    await load();
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "Try again." });
  }
}

async function copy(link: string): Promise<void> {
  await navigator.clipboard.writeText(link);
  toast.show({ title: "Invitation link copied" });
}

async function rename(): Promise<void> {
  if (renaming.value || name.value.trim() === team.value?.name) return;
  renaming.value = true;
  try {
    await renameConsoleTeam(name.value);
    reloadConsoleAccount();
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "Try again." });
    renaming.value = false;
  }
}
</script>

<template>
  <div class="grid max-w-2xl gap-8">
    <header class="grid gap-1">
      <h1 class="text-xl font-semibold text-highlighted">{{ team?.name ?? "Team" }}</h1>
      <p class="text-sm text-pretty text-muted">Everyone in the team opens its linked apps. Owners and admins link apps and invite people.</p>
    </header>

    <section v-if="manage" class="grid gap-2" aria-labelledby="vitehub-team-invite">
      <h2 id="vitehub-team-invite" class="text-sm font-semibold text-highlighted">Invite people</h2>
      <form class="grid gap-1.5" @submit.prevent="invite">
        <div class="flex flex-wrap gap-2">
          <UInput v-model="email" type="email" autocomplete="off" placeholder="name@example.com" aria-label="Email" required class="min-w-56 flex-1" />
          <USelect v-model="role" :items="[{ label: 'Member', value: 'member' }, { label: 'Admin', value: 'admin' }]" aria-label="Role" class="w-28" />
          <UButton type="submit" icon="i-lucide-user-plus" label="Invite" :loading="inviting" />
        </div>
        <p v-if="inviteProblem" role="alert" class="text-[13px] text-error">{{ inviteProblem }}</p>
        <p v-else class="text-xs text-dimmed">Use the email of their GitHub account. The Console copies a link for you to send; it sends no email.</p>
      </form>
    </section>

    <section class="grid gap-2" aria-labelledby="vitehub-team-members">
      <h2 id="vitehub-team-members" class="text-sm font-semibold text-highlighted">
        Members <span v-if="details" class="font-normal tabular-nums text-dimmed">{{ details.members.length }}</span>
      </h2>
      <p v-if="loadProblem" role="alert" class="text-[13px] text-error">{{ loadProblem }}</p>
      <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default">
        <template v-if="!details && !loadProblem">
          <li v-for="index in 2" :key="index" class="flex items-center gap-3 px-3.5 py-2.5">
            <USkeleton class="size-7 rounded-full" />
            <USkeleton class="h-3.5 w-40" />
          </li>
        </template>
        <li v-for="member in details?.members ?? []" :key="member.id" class="flex items-center gap-3 px-3.5 py-2.5">
          <UAvatar :src="member.user.image ?? undefined" :alt="member.user.name" :text="initials(member.user.name)" size="sm" />
          <span class="grid min-w-0 flex-1">
            <span class="truncate text-sm font-medium text-highlighted">
              {{ member.user.name }}<span v-if="member.user.id === account?.user.id" class="font-normal text-dimmed"> (you)</span>
            </span>
            <span v-if="visibleEmail(member.user.email)" class="truncate text-xs text-dimmed">{{ visibleEmail(member.user.email) }}</span>
          </span>
          <UBadge :label="member.role" color="neutral" variant="subtle" size="sm" class="capitalize" />
          <UTooltip v-if="manage && member.role !== 'owner' && member.user.id !== account?.user.id" text="Remove from team">
            <UButton icon="i-lucide-user-minus" size="xs" color="neutral" variant="ghost" :aria-label="`Remove ${member.user.name}`" @click="run(() => removeConsoleMember(member.id), `${member.user.name} removed`)" />
          </UTooltip>
        </li>
      </ul>
    </section>

    <section v-if="details?.invitations.length" class="grid gap-2" aria-labelledby="vitehub-team-invitations">
      <h2 id="vitehub-team-invitations" class="text-sm font-semibold text-highlighted">Pending invitations</h2>
      <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default">
        <li v-for="invitation in details.invitations" :key="invitation.id" class="flex items-center gap-3 px-3.5 py-2.5">
          <span class="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-accented text-dimmed"><UIcon name="i-lucide-mail" class="size-3.5" /></span>
          <span class="grid min-w-0 flex-1">
            <span class="truncate text-sm text-highlighted">{{ invitation.email }}</span>
            <span class="text-xs text-dimmed">Expires {{ new Date(invitation.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) }}</span>
          </span>
          <UBadge :label="invitation.role" color="neutral" variant="outline" size="sm" class="capitalize" />
          <UTooltip text="Copy link">
            <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" :aria-label="`Copy the invitation link for ${invitation.email}`" @click="copy(invitation.link)" />
          </UTooltip>
          <UTooltip v-if="manage" text="Cancel invitation">
            <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="`Cancel the invitation for ${invitation.email}`" @click="run(() => cancelConsoleInvitation(invitation.id), 'Invitation canceled')" />
          </UTooltip>
        </li>
      </ul>
    </section>

    <section v-if="manage" class="grid gap-2" aria-labelledby="vitehub-team-name">
      <h2 id="vitehub-team-name" class="text-sm font-semibold text-highlighted">Team name</h2>
      <form class="flex flex-wrap gap-2" @submit.prevent="rename">
        <UInput v-model="name" aria-label="Team name" required class="min-w-56 flex-1" />
        <UButton type="submit" color="neutral" variant="outline" label="Save" :loading="renaming" :disabled="name.trim() === team?.name" />
      </form>
    </section>
  </div>
</template>
