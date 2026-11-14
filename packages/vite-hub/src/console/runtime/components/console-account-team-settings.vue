<script setup lang="ts">
import { computed, ref } from "vue";

import { leaveConsoleTeam, renameConsoleTeam } from "../client/account";
import { canManageConsoleProjects, reloadConsoleAccount, useConsoleProjects } from "../client/project-session";
import { useConsoleToast } from "../client/toast";
import ConsoleSettings from "./console-settings.vue";
import ConsoleSettingsCard from "./console-settings-card.vue";
import ConsoleSettingsValue from "./console-settings-value.vue";

/** The Team settings page of an `account` Console: the team name and ID, and leaving the team. */
const projects = useConsoleProjects();
const toast = useConsoleToast();
const account = computed(() => projects.account.value);
const team = computed(() => account.value?.teams.find(item => item.id === account.value?.teamId));
const manage = computed(() => account.value ? canManageConsoleProjects(account.value) : false);
// The last owner of a team cannot leave it, so owners do not get the button.
const canLeave = computed(() => Boolean(team.value) && !account.value?.roles.includes("owner"));

const sections = computed(() => [
  { id: "general", label: "General" },
  ...(canLeave.value ? [{ id: "danger", label: "Danger zone" }] : []),
].map(item => ({ ...item, href: `${window.location.pathname}${item.id === "general" ? "" : `#${item.id}`}` })));
const requested = ref(window.location.hash.slice(1));
const section = computed(() => sections.value.some(item => item.id === requested.value) ? requested.value : "general");

/** The section is in the address, so a reload or a shared link opens it. */
function select(id: string): void {
  requested.value = id;
  window.history.replaceState(window.history.state, "", sections.value.find(item => item.id === id)?.href);
}

const name = ref(team.value?.name ?? "");
const renaming = ref(false);

async function rename(): Promise<void> {
  if (renaming.value || name.value.trim() === team.value?.name) return;
  renaming.value = true;
  try {
    await renameConsoleTeam(name.value);
    // The page loads again where it is, so the new name in the field and the sidebar confirms the change.
    window.location.reload();
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "Try again." });
    renaming.value = false;
  }
}

const leaving = ref(false);
const leaveBusy = ref(false);
const leaveProblem = ref<string>();

async function leave(): Promise<void> {
  const current = team.value;
  if (!current || leaveBusy.value) return;
  leaveBusy.value = true;
  leaveProblem.value = undefined;
  try {
    // The session opens another team of the person, so the Console does not load without one.
    await leaveConsoleTeam(current.id, account.value?.teams.find(item => item.id !== current.id)?.id);
    reloadConsoleAccount();
  }
  catch (error) {
    leaveProblem.value = error instanceof Error ? error.message : `You did not leave ${current.name}. Try again.`;
    leaveBusy.value = false;
  }
}

function closeLeave(): void {
  leaving.value = false;
  leaveProblem.value = undefined;
}
</script>

<template>
  <ConsoleSettings label="Team settings" :sections="sections" :current="section" @select="select">
    <template v-if="section === 'general'">
      <ConsoleSettingsCard v-if="manage" title="Team name" description="Members see it in the sidebar and in the team menu.">
        <form id="vitehub-team-settings-name" @submit.prevent="rename">
          <UInput v-model="name" aria-label="Team name" required class="w-full max-w-105" />
        </form>
        <template #footer>Owners and admins can change it.</template>
        <template #action>
          <UButton type="submit" form="vitehub-team-settings-name" size="sm" label="Save" :loading="renaming" :disabled="!name.trim() || name.trim() === team?.name" />
        </template>
      </ConsoleSettingsCard>
      <ConsoleSettingsCard v-else title="Team name" description="Members see it in the sidebar and in the team menu.">
        <ConsoleSettingsValue label="Team name" :value="team?.name" />
        <template #footer>Only owners and admins can change it.</template>
      </ConsoleSettingsCard>

      <ConsoleSettingsCard title="Team ID" description="The ID of this team in the Console.">
        <ConsoleSettingsValue label="Team ID" :value="team?.id" mono copy />
        <template #footer>The Console made it when the team was created.</template>
      </ConsoleSettingsCard>
    </template>

    <ConsoleSettingsCard
      v-else-if="section === 'danger'"
      title="Leave team"
      :description="`You can no longer open the apps of ${team?.name ?? 'this team'}. An owner or admin can invite you again.`"
      danger
    >
      <template #footer>The apps of the team keep running.</template>
      <template #action>
        <UButton size="sm" color="error" variant="outline" label="Leave team" @click="leaving = true" />
      </template>
    </ConsoleSettingsCard>

    <UModal
      :open="leaving"
      :title="`Leave ${team?.name ?? 'the team'}?`"
      description="You can no longer open its apps. An owner or admin can invite you again."
      :dismissible="!leaveBusy"
      :close="{ disabled: leaveBusy }"
      :ui="{ content: 'sm:max-w-[440px]' }"
      @update:open="(value: boolean) => { if (!value) closeLeave(); }"
    >
      <template v-if="leaveProblem" #body>
        <p role="alert" class="text-[13px] text-error">{{ leaveProblem }}</p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="leaveBusy" @click="closeLeave" />
          <UButton color="error" label="Leave team" :loading="leaveBusy" @click="leave" />
        </div>
      </template>
    </UModal>
  </ConsoleSettings>
</template>
