<script setup lang="ts">
import { ref, watch } from "vue";

import { createConsoleTeam } from "../client/account";
import { reloadConsoleAccount } from "../client/project-session";

const open = defineModel<boolean>("open", { required: true });

const teamName = ref("");
const busy = ref(false);
const problem = ref<string>();

watch(open, () => {
  teamName.value = "";
  problem.value = undefined;
  busy.value = false;
});

async function create(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  try {
    await createConsoleTeam(teamName.value);
    reloadConsoleAccount();
  }
  catch (error) {
    problem.value = error instanceof Error ? error.message : "Try again.";
    busy.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Create team" description="A team shares its apps with its members. You will be the owner." :ui="{ content: 'sm:max-w-[440px]' }">
    <template #body>
      <form id="vitehub-account-team" class="grid gap-3" @submit.prevent="create">
        <UFormField label="Team name" name="team" required>
          <UInput v-model="teamName" required class="w-full" autofocus />
        </UFormField>
        <p v-if="problem" role="alert" class="text-[13px] text-error">{{ problem }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="vitehub-account-team" label="Create team" :loading="busy" />
      </div>
    </template>
  </UModal>
</template>
