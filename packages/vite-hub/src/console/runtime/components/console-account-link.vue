<script setup lang="ts">
import { ref, watch } from "vue";

import { linkAccountProject } from "../client/project-session";

/**
 * Link an app to the active team of an `account` Console. The Console server makes the token, and the Console then
 * opens the project, which shows the variable to set on the app until the app accepts the token.
 */
const open = defineModel<boolean>("open", { required: true });
const url = ref("");
const label = ref("");
const busy = ref(false);
const problem = ref<string>();

watch(open, (value) => {
  if (value) return;
  url.value = "";
  label.value = "";
  problem.value = undefined;
  busy.value = false;
});

async function link(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  try {
    await linkAccountProject(url.value, label.value);
  }
  catch (error) {
    problem.value = error instanceof Error ? error.message : "Try again.";
    busy.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Link project" description="Link a deployed ViteHub app to this team." :ui="{ content: 'sm:max-w-[480px]' }">
    <template #body>
      <form id="vitehub-account-link" class="grid gap-3" @submit.prevent="link">
        <UFormField label="App URL" name="url" help="The https:// URL of the app, such as https://app.example.com." required>
          <UInput v-model="url" type="url" inputmode="url" autocomplete="url" placeholder="https://app.example.com" class="w-full" autofocus />
        </UFormField>
        <UFormField label="Name" name="label" hint="Optional">
          <UInput v-model="label" class="w-full" />
        </UFormField>
        <p v-if="problem" role="alert" class="text-[13px] text-error">{{ problem }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="vitehub-account-link" label="Link project" :loading="busy" />
      </div>
    </template>
  </UModal>
</template>
