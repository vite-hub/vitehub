<script setup lang="ts">
import { PrimitiveRailItem } from "@vite-hub/ui/primitive-rail";
import { computed, ref, watch } from "vue";

import type { DropdownMenuItem } from "@nuxt/ui";
import { addConsolePasskey, canManageConsoleProjects, createConsoleTeam, inviteConsoleMember, linkConsoleGitHub, signOutConsoleAccount, switchConsoleTeam } from "../client/account";
import { reloadConsoleAccount, useConsoleProjects } from "../client/project-session";
import { useConsoleToast } from "../client/toast";

/** The account menu of an `account` Console: teams, invitations, sign-in methods, and sign out. */
const props = defineProps<{ expanded: boolean, appearanceItems: DropdownMenuItem[] }>();

const projects = useConsoleProjects();
const toast = useConsoleToast();
const account = computed(() => projects.account.value);
const dialog = ref<"team" | "invite">();
const teamName = ref("");
const inviteEmail = ref("");
const inviteRole = ref<"member" | "admin">("member");
const inviteLink = ref<string>();
const busy = ref(false);
const problem = ref<string>();

const label = computed(() => account.value?.user.name || "Account");
const initials = computed(() => label.value.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase());
const email = computed(() => account.value?.hasEmail ? account.value.user.email : undefined);

watch(dialog, () => {
  teamName.value = "";
  inviteEmail.value = "";
  inviteRole.value = "member";
  inviteLink.value = undefined;
  problem.value = undefined;
  busy.value = false;
});

async function step(action: () => Promise<void>, done: string): Promise<void> {
  try {
    await action();
    toast.show({ title: done });
  }
  catch (error) {
    // A person who closed the browser's passkey sheet changed nothing.
    if (error instanceof DOMException && error.name === "NotAllowedError") return;
    toast.show({ title: error instanceof Error ? error.message : "Try again." });
  }
}

const items = computed<DropdownMenuItem[][]>(() => {
  const current = account.value;
  if (!current) return [props.appearanceItems];
  const manage = canManageConsoleProjects(current);
  return [
    [{ type: "label", label: label.value }, ...(email.value ? [{ type: "label" as const, label: email.value }] : [])],
    [
      { type: "label", label: "Teams" },
      ...current.teams.map((team): DropdownMenuItem => ({
        type: "checkbox",
        label: team.name,
        checked: team.id === current.teamId,
        onSelect: () => {
          if (team.id !== current.teamId) void switchConsoleTeam(team.id).then(reloadConsoleAccount, error => toast.show({ title: error instanceof Error ? error.message : "Try again." }));
        },
      })),
      { icon: "i-lucide-plus", label: "New team", onSelect: () => { dialog.value = "team"; } },
      ...(manage ? [{ icon: "i-lucide-user-plus", label: "Invite to team", onSelect: () => { dialog.value = "invite"; } }] : []),
    ],
    [
      { icon: "i-lucide-key-round", label: "Add a passkey", onSelect: () => void step(addConsolePasskey, "Passkey added") },
      { icon: "i-lucide-github", label: "Connect GitHub", onSelect: () => void step(() => linkConsoleGitHub(projects.pageOrigin), "Opening GitHub…") },
    ],
    props.appearanceItems,
    [{ icon: "i-lucide-log-out", label: "Sign out", onSelect: () => void signOutConsoleAccount().then(reloadConsoleAccount) }],
  ];
});

async function submit(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  try {
    if (dialog.value === "team") {
      await createConsoleTeam(teamName.value);
      reloadConsoleAccount();
      return;
    }
    inviteLink.value = await inviteConsoleMember(inviteEmail.value, inviteRole.value);
  }
  catch (error) {
    problem.value = error instanceof Error ? error.message : "Try again.";
  }
  busy.value = false;
}
</script>

<template>
  <UDropdownMenu :items="items" :content="{ side: 'right', align: 'end', sideOffset: 8 }" :ui="{ content: 'min-w-56' }">
    <UTooltip :text="label" :content="{ side: 'right' }" :disabled="expanded">
      <PrimitiveRailItem :label="label">
        <UAvatar :src="account?.user.image ?? undefined" :alt="label" :text="initials" size="sm" class="size-5" />
      </PrimitiveRailItem>
    </UTooltip>
  </UDropdownMenu>

  <UModal
    :open="dialog !== undefined"
    :title="dialog === 'team' ? 'New team' : 'Invite to team'"
    :description="dialog === 'team' ? 'Teams share their linked projects. You will be the owner.' : 'Invite a person by the email of their GitHub account. They open the link and sign in with GitHub.'"
    :ui="{ content: 'sm:max-w-[440px]' }"
    @update:open="(value: boolean) => { if (!value) dialog = undefined; }"
  >
    <template #body>
      <form id="vitehub-account-dialog" class="grid gap-3" @submit.prevent="submit">
        <UFormField v-if="dialog === 'team'" label="Team name" name="team" required>
          <UInput v-model="teamName" class="w-full" autofocus />
        </UFormField>
        <template v-else-if="!inviteLink">
          <UFormField label="Email" name="email" required>
            <UInput v-model="inviteEmail" type="email" autocomplete="off" class="w-full" autofocus />
          </UFormField>
          <UFormField label="Role" name="role">
            <USelect v-model="inviteRole" :items="[{ label: 'Member: opens projects', value: 'member' }, { label: 'Admin: also links projects and invites', value: 'admin' }]" class="w-full" />
          </UFormField>
        </template>
        <template v-else>
          <p class="text-[13px] text-muted">Send this link to {{ inviteEmail }}. It works for 48 hours.</p>
          <UInput :model-value="inviteLink" readonly class="w-full font-mono" @focus="(event: FocusEvent) => (event.target as HTMLInputElement).select()" />
        </template>
        <p v-if="problem" role="alert" class="text-[13px] text-error">{{ problem }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :label="inviteLink ? 'Done' : 'Cancel'" @click="dialog = undefined" />
        <UButton v-if="!inviteLink" type="submit" form="vitehub-account-dialog" :label="dialog === 'team' ? 'Create team' : 'Create invitation'" :loading="busy" />
      </div>
    </template>
  </UModal>
</template>
