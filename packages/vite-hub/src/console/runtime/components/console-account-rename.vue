<script setup lang="ts">
import { ref, watch } from "vue";

import { renameAccountProject } from "../client/project-session";

/**
 * Renames an app of the team in the Console. The link, its key, and the app stay the same. Without a name, the Console
 * shows the name that the app reports, from its `package.json`.
 */
const props = defineProps<{ projectId: string, label: string | null, reported: string }>();
const open = defineModel<boolean>("open", { required: true });

const name = ref(props.label ?? "");
const busy = ref(false);
const problem = ref<string>();

watch(open, (value) => {
  if (!value) return;
  name.value = props.label ?? "";
  busy.value = false;
  problem.value = undefined;
});

async function save(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  try {
    await renameAccountProject(props.projectId, name.value);
    // The page loads again where it is, so every place that shows the name updates.
    window.location.reload();
  }
  catch (error) {
    problem.value = error instanceof Error ? error.message : "The app was not renamed. Try again.";
    busy.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Rename app"
    description="Everyone in the team sees this name. The app and its variable do not change."
    :dismissible="!busy"
    :close="{ disabled: busy }"
    :ui="{ content: 'sm:max-w-[440px]' }"
  >
    <template #body>
      <form id="vitehub-account-rename" class="grid gap-4" @submit.prevent="save">
        <UFormField label="Name" name="label" :help="`Leave it empty to show ${reported}.`" :error="problem">
          <!-- Nuxt UI hides the help while an error slot exists, so the slot is there only for an error. -->
          <template v-if="problem" #error="{ error }">
            <span role="alert">{{ error }}</span>
          </template>
          <UInput v-model="name" :placeholder="reported" class="w-full" autofocus />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" :disabled="busy" @click="open = false" />
        <UButton type="submit" form="vitehub-account-rename" label="Save" :loading="busy" :disabled="name.trim() === (label ?? '')" />
      </div>
    </template>
  </UModal>
</template>
