<script setup lang="ts">
import { CopyButton } from "@vite-hub/ui";
import { computed, onMounted, ref, shallowRef, watch } from "vue";

import type { ConsoleApiKey } from "../client/account";
import { createConsoleApiKey, listConsoleApiKeys, revokeConsoleApiKey } from "../client/account";
import { consoleProjectDisplayName, useConsoleProjects } from "../client/project-session";
import { useConsoleToast } from "../client/toast";
import ConsoleSettingsCard from "./console-settings-card.vue";
import Icon from "./console-icon.vue";

/**
 * The API keys of the signed-in person, in Account settings. A key acts as the person in one team, on every project of
 * the team or on the projects it names. `vitehub login` makes one with the device flow. The page shows a new key once.
 */
const projects = useConsoleProjects();
const toast = useConsoleToast();
const account = computed(() => projects.account.value);
const team = computed(() => account.value?.teams.find(item => item.id === account.value?.teamId));
const teamProjects = computed(() => (account.value?.projects ?? []).map(project => ({ label: consoleProjectDisplayName(project), value: project.id })));

const keys = shallowRef<ConsoleApiKey[]>();
const loadProblem = ref(false);
const creating = ref(false);
const name = ref("");
const scope = ref<string[]>([]);
const days = ref(90);
const createBusy = ref(false);
const createProblem = ref<string>();
const created = ref<string>();
const revoking = ref<ConsoleApiKey>();
const revokeBusy = ref(false);

const lifetimes = [{ label: "30 days", value: 30 }, { label: "90 days", value: 90 }, { label: "1 year", value: 365 }];
const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

async function load(): Promise<void> {
  try {
    keys.value = await listConsoleApiKeys();
    loadProblem.value = false;
  }
  catch {
    loadProblem.value = true;
  }
}

onMounted(load);

watch(creating, (value) => {
  if (value) return;
  name.value = "";
  scope.value = [];
  days.value = 90;
  createProblem.value = undefined;
  createBusy.value = false;
  // The key leaves the page with the dialog.
  created.value = undefined;
});

async function create(): Promise<void> {
  if (createBusy.value) return;
  createBusy.value = true;
  createProblem.value = undefined;
  try {
    const answer = await createConsoleApiKey({ name: name.value, days: days.value, ...(scope.value.length ? { projectIds: scope.value } : {}) });
    created.value = answer.key;
    await load();
  }
  catch (error) {
    createProblem.value = error instanceof Error ? error.message : "The key was not made. Try again.";
  }
  createBusy.value = false;
}

function copyKeyFailed(): void {
  toast.show({ title: "The browser blocked the clipboard. Select the key and copy it." });
}

async function revoke(): Promise<void> {
  const key = revoking.value;
  if (!key || revokeBusy.value) return;
  revokeBusy.value = true;
  try {
    await revokeConsoleApiKey(key.id);
    toast.show({ title: "API key revoked" });
    revoking.value = undefined;
    await load();
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "The key was not revoked. Try again." });
  }
  revokeBusy.value = false;
}

function detail(key: ConsoleApiKey): string {
  const scopeLabel = key.projectIds ? `${key.projectIds.length} ${key.projectIds.length === 1 ? "project" : "projects"}` : "All projects";
  const expiry = key.expiresAt <= Date.now() ? "Expired" : `Expires ${dateFormat.format(new Date(key.expiresAt))}`;
  const used = key.lastUsedAt ? `Last used ${dateFormat.format(new Date(key.lastUsedAt))}` : "Never used";
  return `${key.team.name} · ${scopeLabel} · ${expiry} · ${used}`;
}
</script>

<template>
  <ConsoleSettingsCard title="API keys" description="A key acts as you in one team, for the CLI and for CI." heading-id="vitehub-settings-api-keys">
    <ul class="vitehub-account-list">
      <template v-if="!keys && !loadProblem">
        <li class="vitehub-account-list__row" aria-hidden="true">
          <USkeleton class="vitehub-account-icon shrink-0" />
          <span class="grid flex-1 gap-1.5 py-0.5">
            <USkeleton class="h-3.5 w-24" />
            <USkeleton class="h-3 w-56" />
          </span>
        </li>
      </template>
      <li v-if="keys && !keys.length" class="vitehub-account-list__row text-sm text-muted">No API keys yet.</li>
      <li v-for="key in keys ?? []" :key="key.id" class="vitehub-account-list__row">
        <Icon name="i-lucide-key-square" class="vitehub-account-icon shrink-0 text-muted" aria-hidden="true" />
        <span class="grid min-w-0 flex-1">
          <span class="flex min-w-0 items-baseline gap-2">
            <span class="truncate text-sm font-medium text-highlighted">{{ key.name }}</span>
            <code class="shrink-0 font-mono text-xs text-muted">{{ key.start }}…</code>
          </span>
          <span class="truncate text-xs text-muted">{{ detail(key) }}</span>
        </span>
        <UTooltip text="Revoke key">
          <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" :aria-label="`Revoke the API key ${key.name}`" @click="revoking = key" />
        </UTooltip>
      </li>
    </ul>
    <div v-if="loadProblem" role="alert" class="flex items-center gap-2 text-[13px] text-error">
      The API keys did not load.
      <UButton size="xs" color="neutral" variant="ghost" label="Retry" @click="load()" />
    </div>
    <template #footer><code class="font-mono">vitehub login</code> makes one for you.</template>
    <template v-if="team" #action>
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus" label="Create a key" @click="creating = true" />
    </template>

    <UModal
      v-model:open="creating"
      :title="created ? 'Copy your API key' : 'Create an API key'"
      :description="created ? 'This is the only time the Console shows it. Store it in a password manager or a CI secret.' : `It acts as you in ${team?.name ?? 'this team'}.`"
      :dismissible="!createBusy"
      :ui="{ content: 'sm:max-w-[440px]' }"
    >
      <template #body>
        <div v-if="created" class="flex gap-2">
          <UInput :model-value="created" readonly aria-label="API key" class="min-w-0 flex-1 font-mono" @focus="($event.target as HTMLInputElement).select()" />
          <CopyButton :value="created" color="neutral" variant="outline" label="Copy" @error="copyKeyFailed" />
        </div>
        <form v-else id="vitehub-api-key-create" class="grid gap-4" @submit.prevent="create">
          <UFormField label="Name" name="name" required :error="createProblem" :ui="{ error: createProblem ? undefined : 'mt-0' }">
            <template #error="{ error }">
              <span role="alert">{{ error }}</span>
            </template>
            <UInput v-model="name" required maxlength="100" placeholder="GitHub Actions" class="w-full" autofocus />
          </UFormField>
          <UFormField label="Projects" name="projects" hint="Optional" help="Without projects, the key opens every project of the team.">
            <USelectMenu v-model="scope" :items="teamProjects" value-key="value" multiple placeholder="All projects" class="w-full" />
          </UFormField>
          <UFormField label="Expires after" name="days">
            <USelect v-model="days" :items="lifetimes" class="w-full" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <template v-if="created">
            <UButton label="Done" @click="creating = false" />
          </template>
          <template v-else>
            <UButton color="neutral" variant="ghost" label="Cancel" :disabled="createBusy" @click="creating = false" />
            <UButton type="submit" form="vitehub-api-key-create" label="Create key" :loading="createBusy" />
          </template>
        </div>
      </template>
    </UModal>

    <UModal
      :open="revoking !== undefined"
      :title="`Revoke ${revoking?.name ?? 'this key'}?`"
      description="The CLI or CI job that uses it stops working at once."
      :dismissible="!revokeBusy"
      :ui="{ content: 'sm:max-w-[440px]' }"
      @update:open="(value: boolean) => { if (!value) revoking = undefined; }"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="revokeBusy" @click="revoking = undefined" />
          <UButton color="error" label="Revoke key" :loading="revokeBusy" @click="revoke" />
        </div>
      </template>
    </UModal>
  </ConsoleSettingsCard>
</template>
