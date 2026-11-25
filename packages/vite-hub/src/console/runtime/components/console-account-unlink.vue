<script setup lang="ts">
import { ref, watch } from "vue";

import { forgetConsoleProject } from "../client/project-session";

const props = defineProps<{ projectId: string, name: string }>();
const open = defineModel<boolean>("open", { required: true });

const busy = ref(false);
const problem = ref<string>();

watch(open, () => {
  busy.value = false;
  problem.value = undefined;
});

async function unlink(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  try {
    // The Console loads again at its home path after the unlink.
    await forgetConsoleProject(props.projectId);
  }
  catch {
    problem.value = `${props.name} was not unlinked. Check the connection and try again.`;
    busy.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="`Unlink ${name}?`"
    description="The link key stops working. Hosted comment threads and replies for this app are permanently deleted."
    :dismissible="!busy"
    :close="{ disabled: busy }"
    :ui="{ content: 'sm:max-w-[440px]' }"
  >
    <template v-if="problem" #body>
      <p role="alert" class="text-[13px] text-error">{{ problem }}</p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" :disabled="busy" @click="open = false" />
        <UButton color="error" label="Unlink and delete comments" :loading="busy" @click="unlink" />
      </div>
    </template>
  </UModal>
</template>
