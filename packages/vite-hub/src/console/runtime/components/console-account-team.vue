<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef } from "vue";

import type { ConsoleTeamDetails, ConsoleTeamMember } from "../client/account";
import { cancelConsoleInvitation, earlyConsoleTeam, inviteConsoleMember, loadConsoleTeam, removeConsoleMember } from "../client/account";
import { canManageConsoleProjects, useConsoleProjects } from "../client/project-session";
import { useConsoleToast } from "../client/toast";

/** The Members page of an `account` Console: the people and the pending invitations. Team settings has the team name. */
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
const removing = ref<ConsoleTeamMember>();
const removeBusy = ref(false);
const removeProblem = ref<string>();

/** Focus a list heading once a dialog has closed, after the row that held the focused button is gone. */
function focusHeading(id: string): void {
  void nextTick(() => setTimeout(() => document.getElementById(id)?.focus(), 300));
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

async function load(answer = loadConsoleTeam()): Promise<void> {
  try {
    details.value = await answer;
    loadProblem.value = undefined;
  }
  catch (error) {
    loadProblem.value = error instanceof Error ? error.message : "The team did not load.";
  }
}

// The link to this page starts the load when the pointer or the focus reaches it.
onMounted(() => load(earlyConsoleTeam.take()));

function initials(text: string): string {
  return text.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase();
}

function visibleEmail(value: string): string | undefined {
  return value.endsWith("@passkey.invalid") ? undefined : value;
}

function expires(value: string): string {
  const hours = Math.round((new Date(value).getTime() - Date.now()) / 3_600_000);
  return `Expires ${hours < 24 ? relative.format(hours, "hour") : relative.format(Math.round(hours / 24), "day")}`;
}

async function invite(): Promise<void> {
  if (inviting.value) return;
  inviting.value = true;
  inviteProblem.value = undefined;
  try {
    const link = await inviteConsoleMember(email.value, role.value);
    const copied = await navigator.clipboard.writeText(link).then(() => true, () => false);
    toast.show({ title: copied ? `Invite link copied. Send it to ${email.value}.` : "Invitation created. Copy its link below.", duration: 8_000 });
    email.value = "";
    await load();
  }
  catch (error) {
    inviteProblem.value = error instanceof Error ? error.message : "Try again.";
  }
  inviting.value = false;
}

async function cancel(id: string): Promise<void> {
  try {
    await cancelConsoleInvitation(id);
    toast.show({ title: "Invitation canceled" });
    await load();
    focusHeading(details.value?.invitations.length ? "vitehub-team-invitations" : "vitehub-team-members");
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "Try again." });
  }
}

async function remove(): Promise<void> {
  const member = removing.value;
  if (!member || removeBusy.value) return;
  removeBusy.value = true;
  removeProblem.value = undefined;
  try {
    await removeConsoleMember(member.id);
    toast.show({ title: `${member.user.name} removed from ${team.value?.name ?? "the team"}` });
    removeBusy.value = false;
    removing.value = undefined;
    await load();
    focusHeading("vitehub-team-members");
  }
  catch (error) {
    removeProblem.value = error instanceof Error ? error.message : `${member.user.name} was not removed. Try again.`;
    removeBusy.value = false;
  }
}

async function copy(link: string): Promise<void> {
  const copied = await navigator.clipboard.writeText(link).then(() => true, () => false);
  toast.show({ title: copied ? "Invite link copied" : "The browser blocked the clipboard. Allow it and try again." });
}
</script>

<template>
  <div class="grid max-w-2xl gap-10">
    <p class="text-sm text-pretty text-muted">Everyone in {{ team?.name ?? "the team" }} opens its apps. Owners and admins also link apps and invite people.</p>

    <section v-if="manage" class="grid gap-3" aria-labelledby="vitehub-team-invite">
      <h2 id="vitehub-team-invite" class="text-sm font-semibold text-highlighted">Invite people</h2>
      <form class="grid gap-1.5" @submit.prevent="invite">
        <div class="flex flex-wrap gap-2">
          <UInput v-model="email" type="email" autocomplete="off" placeholder="name@example.com" aria-label="Email" aria-describedby="vitehub-team-invite-help" required class="min-w-0 flex-1 basis-56" />
          <USelect v-model="role" :items="[{ label: 'Member', value: 'member' }, { label: 'Admin', value: 'admin' }]" aria-label="Role" class="w-28" />
          <UButton type="submit" icon="i-lucide-user-plus" label="Create invite link" class="justify-center max-sm:flex-1" :loading="inviting" />
        </div>
        <p v-if="inviteProblem" id="vitehub-team-invite-help" role="alert" class="text-[13px] text-error">{{ inviteProblem }}</p>
        <p v-else id="vitehub-team-invite-help" class="text-xs text-muted">Use their GitHub email. Copy and send the link yourself.</p>
      </form>
    </section>

    <section class="grid gap-3" aria-labelledby="vitehub-team-members">
      <h2 id="vitehub-team-members" tabindex="-1" class="text-sm font-semibold text-highlighted outline-none">
        People <span v-if="details" class="font-normal tabular-nums text-muted">{{ details.members.length }}</span>
      </h2>
      <p v-if="loadProblem" role="alert" class="text-[13px] text-error">{{ loadProblem }}</p>
      <ul class="vitehub-account-list">
        <template v-if="!details && !loadProblem">
          <li v-for="index in 2" :key="index" class="vitehub-account-list__row">
            <USkeleton class="size-7 rounded-full" />
            <USkeleton class="h-3.5 w-40" />
          </li>
        </template>
        <li v-for="member in details?.members ?? []" :key="member.id" class="vitehub-account-list__row">
          <UAvatar :src="member.user.image ?? undefined" :alt="member.user.name" :text="initials(member.user.name)" size="sm" />
          <span class="grid min-w-0 flex-1">
            <span class="truncate text-sm font-medium text-highlighted">
              {{ member.user.name }}<span v-if="member.user.id === account?.user.id" class="font-normal text-muted"> (you)</span>
            </span>
            <span v-if="visibleEmail(member.user.email)" class="truncate text-xs text-muted">{{ visibleEmail(member.user.email) }}</span>
          </span>
          <span class="text-xs text-muted capitalize">{{ member.role }}</span>
          <UTooltip v-if="manage && member.role !== 'owner' && member.user.id !== account?.user.id" text="Remove from team">
            <UButton icon="i-lucide-user-minus" size="xs" color="neutral" variant="ghost" :aria-label="`Remove ${member.user.name}`" @click="removing = member" />
          </UTooltip>
        </li>
      </ul>
    </section>

    <section v-if="details?.invitations.length" class="grid gap-3" aria-labelledby="vitehub-team-invitations">
      <h2 id="vitehub-team-invitations" tabindex="-1" class="text-sm font-semibold text-highlighted outline-none">Pending invitations</h2>
      <ul class="vitehub-account-list">
        <li v-for="invitation in details.invitations" :key="invitation.id" class="vitehub-account-list__row">
          <span class="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-accented text-muted" aria-hidden="true"><UIcon name="i-lucide-mail" class="size-3.5" /></span>
          <span class="grid min-w-0 flex-1">
            <span class="truncate text-sm text-highlighted">{{ invitation.email }}</span>
            <span class="text-xs text-muted">{{ expires(invitation.expiresAt) }}</span>
          </span>
          <span class="text-xs text-muted capitalize">{{ invitation.role }}</span>
          <UTooltip text="Copy link">
            <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" :aria-label="`Copy the invitation link for ${invitation.email}`" @click="copy(invitation.link)" />
          </UTooltip>
          <UTooltip v-if="manage" text="Cancel invitation">
            <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="`Cancel the invitation for ${invitation.email}`" @click="cancel(invitation.id)" />
          </UTooltip>
        </li>
      </ul>
    </section>

    <UModal
      :open="removing !== undefined"
      :title="`Remove ${removing?.user.name ?? ''}?`"
      :description="`${removing?.user.name ?? 'This person'} can no longer open the apps of ${team?.name ?? 'the team'}. You can invite them again later.`"
      :dismissible="!removeBusy"
      :close="{ disabled: removeBusy }"
      :ui="{ content: 'sm:max-w-[440px]' }"
      @update:open="(value: boolean) => { if (!value) { removing = undefined; removeProblem = undefined; } }"
    >
      <template v-if="removeProblem" #body>
        <p role="alert" class="text-[13px] text-error">{{ removeProblem }}</p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="removeBusy" @click="removing = undefined; removeProblem = undefined" />
          <UButton color="error" :label="`Remove ${removing?.user.name ?? ''}`" :loading="removeBusy" @click="remove" />
        </div>
      </template>
    </UModal>
  </div>
</template>
