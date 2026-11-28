<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";

import type { ConsoleEnvStage, ConsoleEnvVariable } from "../client/account";
import { deleteConsoleEnvValue, loadConsoleEnvStage, revealConsoleEnvValue, setConsoleEnvValue } from "../client/account";
import { consoleProjectDisplayName, useConsoleProjects } from "../client/project-session";
import { useConsoleToast } from "../client/toast";

/**
 * The env values of the team's apps, by stage. Only a Console whose operator turned values on stores them. Otherwise
 * the page says so. Owners and admins set, replace, delete, and reveal values.
 * Members see the names. A value field is write-only: the page shows a value only after a reveal, which the Console logs.
 */
const projects = useConsoleProjects();
const toast = useConsoleToast();
const account = computed(() => projects.account.value);
const apps = computed(() => (account.value?.projects ?? []).map(project => ({ label: consoleProjectDisplayName(project), value: project.id })));

function openedAppOr(list: { value: string }[]): string | undefined {
  const opened = projects.current.value?.id;
  return list.some(app => app.value === opened) ? opened : list[0]?.value;
}
const appId = ref(openedAppOr(apps.value));
watch(apps, (list) => {
  if (!list.some(app => app.value === appId.value)) appId.value = openedAppOr(list);
});
const stage = ref("production");
const state = shallowRef<ConsoleEnvStage>();
const loadProblem = ref<string>();
const stages = computed(() => {
  const listed = state.value && !state.value.off ? state.value.stages : ["production", "preview"];
  return listed.includes(stage.value) ? listed : [...listed, stage.value];
});
const variables = computed<ConsoleEnvVariable[]>(() => state.value && !state.value.off ? state.value.variables : []);
const canWrite = computed(() => state.value !== undefined && !state.value.off && state.value.canReveal);

const editing = ref<{ name: string, replace: boolean }>();
const editName = ref("");
const editValue = ref("");
const editBusy = ref(false);
const editProblem = ref<string>();
const removing = ref<ConsoleEnvVariable>();
const removeBusy = ref(false);
const revealing = ref<ConsoleEnvVariable>();
const revealed = ref<string>();
const revealBusy = ref(false);

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const namePattern = /^[A-Z_a-z]\w{0,255}$/;
const stagePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

async function load(): Promise<void> {
  if (!appId.value) return;
  const target = { app: appId.value, stage: stage.value };
  try {
    const answer = await loadConsoleEnvStage(target.app, target.stage);
    // A later switch wins over an earlier answer.
    if (target.app !== appId.value || target.stage !== stage.value) return;
    state.value = answer;
    loadProblem.value = undefined;
  }
  catch (error) {
    loadProblem.value = error instanceof Error ? error.message : "The env values did not load.";
  }
}

watch([appId, stage], () => {
  state.value = undefined;
  void load();
}, { immediate: true });

function addStage(name: string): void {
  const value = name.trim().toLowerCase();
  if (!stagePattern.test(value)) {
    toast.show({ title: "A stage is lowercase letters, digits, - and _." });
    return;
  }
  stage.value = value;
}

function openEditor(name?: string): void {
  editName.value = name ?? "";
  editValue.value = "";
  editProblem.value = undefined;
  editing.value = { name: name ?? "", replace: name !== undefined };
}

async function save(): Promise<void> {
  if (!appId.value || editBusy.value) return;
  const name = editName.value.trim();
  if (!namePattern.test(name)) {
    editProblem.value = "Use letters, digits, and _, and do not start with a digit, such as API_TOKEN.";
    return;
  }
  editBusy.value = true;
  editProblem.value = undefined;
  try {
    await setConsoleEnvValue(appId.value, stage.value, name, editValue.value);
    // The value leaves the page with the dialog.
    editValue.value = "";
    editing.value = undefined;
    toast.show({ title: `${name} saved in ${stage.value}` });
    await load();
  }
  catch (error) {
    editProblem.value = error instanceof Error ? error.message : "The value was not saved. Try again.";
  }
  editBusy.value = false;
}

async function remove(): Promise<void> {
  const variable = removing.value;
  if (!variable || !appId.value || removeBusy.value) return;
  removeBusy.value = true;
  try {
    await deleteConsoleEnvValue(appId.value, stage.value, variable.name);
    toast.show({ title: `${variable.name} deleted from ${stage.value}` });
    removing.value = undefined;
    await load();
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "The value was not deleted. Try again." });
  }
  removeBusy.value = false;
}

async function reveal(): Promise<void> {
  const variable = revealing.value;
  if (!variable || !appId.value || revealBusy.value) return;
  revealBusy.value = true;
  try {
    revealed.value = await revealConsoleEnvValue(appId.value, stage.value, variable.name) ?? "";
  }
  catch (error) {
    toast.show({ title: error instanceof Error ? error.message : "The value was not revealed. Try again." });
  }
  revealBusy.value = false;
}

function closeReveal(): void {
  revealing.value = undefined;
  revealed.value = undefined;
}

async function copyRevealed(): Promise<void> {
  const copied = revealed.value !== undefined ? await navigator.clipboard.writeText(revealed.value).then(() => true, () => false) : false;
  toast.show({ title: copied ? "Value copied" : "The browser blocked the clipboard. Select the value and copy it." });
}
</script>

<template>
  <div class="grid max-w-2xl gap-6">
    <p class="text-sm text-pretty text-muted">
      Values for <code class="font-mono">vitehub env pull --from console</code>, by app and stage. Whoever runs this Console can read them.
    </p>

    <p v-if="!apps.length" class="text-sm text-muted">Link an app first. Each app has its own values.</p>

    <template v-else>
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="App" name="app" class="min-w-48 flex-1">
          <USelect v-model="appId" :items="apps" class="w-full" />
        </UFormField>
        <UFormField label="Stage" name="stage" class="min-w-40">
          <USelectMenu v-model="stage" :items="stages" create-item class="w-full" :search-input="{ placeholder: 'Find or add a stage' }" @create="addStage" />
        </UFormField>
      </div>

      <UAlert
        v-if="state?.off"
        color="neutral"
        variant="subtle"
        icon="i-lucide-lock"
        title="This Console does not store env values"
        :description="state.message.replace(/^This Console does not store env values\. /, '')"
      />

      <section v-else class="grid gap-3" aria-labelledby="vitehub-env-values">
        <div class="flex items-center justify-between gap-2">
          <h2 id="vitehub-env-values" class="text-sm font-semibold text-highlighted">Values in {{ stage }}</h2>
          <UButton v-if="canWrite" size="sm" color="neutral" variant="ghost" icon="i-lucide-plus" label="Add a value" @click="openEditor()" />
        </div>
        <p v-if="state && !state.off && !state.canReveal" class="text-xs text-muted">You see the names. Owners and admins of the team set and reveal values.</p>
        <ul class="vitehub-account-list">
          <li v-if="!state && !loadProblem" class="vitehub-account-list__row" aria-hidden="true">
            <USkeleton class="vitehub-account-icon shrink-0" />
            <span class="grid flex-1 gap-1.5 py-0.5">
              <USkeleton class="h-3.5 w-28" />
              <USkeleton class="h-3 w-40" />
            </span>
          </li>
          <li v-if="state && !variables.length" class="vitehub-account-list__row text-sm text-muted">No values in {{ stage }} yet.</li>
          <li v-for="variable in variables" :key="variable.name" class="vitehub-account-list__row">
            <UIcon name="i-lucide-key-round" class="vitehub-account-icon shrink-0 text-muted" aria-hidden="true" />
            <span class="grid min-w-0 flex-1">
              <code class="truncate font-mono text-sm text-highlighted">{{ variable.name }}</code>
              <span class="truncate text-xs text-muted">Updated {{ dateFormat.format(new Date(variable.updatedAt)) }}</span>
            </span>
            <template v-if="canWrite">
              <UTooltip text="Reveal">
                <UButton icon="i-lucide-eye" size="xs" color="neutral" variant="ghost" :aria-label="`Reveal ${variable.name}`" @click="revealing = variable" />
              </UTooltip>
              <UTooltip text="Replace">
                <UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" :aria-label="`Replace ${variable.name}`" @click="openEditor(variable.name)" />
              </UTooltip>
              <UTooltip text="Delete">
                <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" :aria-label="`Delete ${variable.name}`" @click="removing = variable" />
              </UTooltip>
            </template>
          </li>
        </ul>
        <div v-if="loadProblem" role="alert" class="flex items-center gap-2 text-[13px] text-error">
          {{ loadProblem }}
          <UButton size="xs" color="neutral" variant="ghost" label="Retry" @click="load()" />
        </div>
      </section>
    </template>

    <UModal
      :open="editing !== undefined"
      :title="editing?.replace ? `Replace ${editing.name}` : `Add a value to ${stage}`"
      description="The Console encrypts the value. It shows it again only after a reveal, which it logs."
      :dismissible="!editBusy"
      :ui="{ content: 'sm:max-w-[440px]' }"
      @update:open="(value: boolean) => { if (!value) { editing = undefined; editValue = ''; } }"
    >
      <template #body>
        <form id="vitehub-env-value" class="grid gap-4" @submit.prevent="save">
          <UFormField label="Name" name="name" required>
            <UInput v-model="editName" required :disabled="editing?.replace" maxlength="256" placeholder="API_TOKEN" class="w-full font-mono" autocomplete="off" spellcheck="false" :autofocus="!editing?.replace" />
          </UFormField>
          <UFormField label="Value" name="value" :error="editProblem" :ui="{ error: editProblem ? undefined : 'mt-0' }">
            <template #error="{ error }">
              <span role="alert">{{ error }}</span>
            </template>
            <UInput v-model="editValue" type="password" class="w-full font-mono" autocomplete="new-password" spellcheck="false" :autofocus="editing?.replace" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="editBusy" @click="editing = undefined" />
          <UButton type="submit" form="vitehub-env-value" :label="editing?.replace ? 'Replace value' : 'Save value'" :loading="editBusy" />
        </div>
      </template>
    </UModal>

    <UModal
      :open="revealing !== undefined"
      :title="revealed === undefined ? `Reveal ${revealing?.name ?? 'this value'}?` : revealing?.name"
      :description="revealed === undefined ? 'The Console logs that you read it.' : 'Close this dialog when you are done. The page forgets the value.'"
      :dismissible="!revealBusy"
      :ui="{ content: 'sm:max-w-[440px]' }"
      @update:open="(value: boolean) => { if (!value) closeReveal(); }"
    >
      <template v-if="revealed !== undefined" #body>
        <div class="flex gap-2">
          <UInput :model-value="revealed" readonly :aria-label="`Value of ${revealing?.name}`" class="min-w-0 flex-1 font-mono" @focus="($event.target as HTMLInputElement).select()" />
          <UButton icon="i-lucide-copy" color="neutral" variant="outline" label="Copy" @click="copyRevealed" />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <template v-if="revealed === undefined">
            <UButton color="neutral" variant="ghost" label="Cancel" :disabled="revealBusy" @click="closeReveal" />
            <UButton label="Reveal" icon="i-lucide-eye" :loading="revealBusy" @click="reveal" />
          </template>
          <UButton v-else label="Done" @click="closeReveal" />
        </div>
      </template>
    </UModal>

    <UModal
      :open="removing !== undefined"
      :title="`Delete ${removing?.name ?? 'this value'} from ${stage}?`"
      description="The next pull or deploy does not get it. The activity keeps the record."
      :dismissible="!removeBusy"
      :ui="{ content: 'sm:max-w-[440px]' }"
      @update:open="(value: boolean) => { if (!value) removing = undefined; }"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="removeBusy" @click="removing = undefined" />
          <UButton color="error" label="Delete value" :loading="removeBusy" @click="remove" />
        </div>
      </template>
    </UModal>
  </div>
</template>
