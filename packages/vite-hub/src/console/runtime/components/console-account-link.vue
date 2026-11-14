<script setup lang="ts">
import { ref, watch } from "vue";

import { linkAccountProject } from "../client/project-session";
import ConsoleAccountSnippet from "./console-account-snippet.vue";

/**
 * Link an app to the active team of an `account` Console. The Console server makes the token, and the Console then
 * opens the project, which shows the variable to set on the app until the app accepts the token.
 */
const open = defineModel<boolean>("open", { required: true });
/** The app URL that the form starts with, such as the app of a `/_vitehub` link. */
const props = defineProps<{ url?: string }>();
const url = ref("");
const label = ref("");
const busy = ref(false);
const problem = ref<string>();

watch(open, (value) => {
  if (value) {
    url.value = props.url ?? "";
    return;
  }
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
  <UModal v-model:open="open" title="Link an app" description="Enable Console access, deploy your app, then enter its URL." :ui="{ content: 'sm:max-w-[440px]' }">
    <template #body>
      <form id="vitehub-account-link" class="grid gap-4" @submit.prevent="link">
        <ConsoleAccountSnippet />
        <UFormField label="App URL" name="url" required :error="problem" :ui="{ error: problem ? undefined : 'mt-0' }">
          <!-- Nuxt UI renders the error without a live region, so the message announces itself here. -->
          <template #error="{ error }">
            <span role="alert">{{ error }}</span>
          </template>
          <UInput v-model="url" required type="url" inputmode="url" autocomplete="url" placeholder="https://app.example.com" class="w-full" autofocus />
        </UFormField>
        <UFormField label="Name" name="label" hint="Optional">
          <UInput v-model="label" class="w-full" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="vitehub-account-link" label="Link app" :loading="busy" />
      </div>
    </template>
  </UModal>
</template>
