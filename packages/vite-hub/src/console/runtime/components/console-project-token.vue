<script setup lang="ts">
import { ref, watch } from "vue";

import type { ConsoleProjectProblem } from "../client/project-link";
import ConsoleProjectProblemAlert from "./console-project-problem.vue";

defineProps<{
  /** Why the last token did not open the project. */
  problem?: ConsoleProjectProblem;
  busy?: boolean;
}>();

const emit = defineEmits<{ submit: [token: string] }>();

const token = ref("");
const empty = ref(false);
// A touch screen keeps its keyboard closed until the person taps the field.
const autofocus = !("ontouchstart" in window);

watch(token, () => {
  empty.value = false;
});

function submit(): void {
  const value = token.value.trim();
  if (!value) {
    empty.value = true;
    return;
  }
  emit("submit", value);
}
</script>

<template>
  <form class="grid gap-4" novalidate @submit.prevent="submit">
    <UFormField
      label="Console token"
      name="token"
      description="The token you created for this project. This browser keeps it with the project."
      :error="empty ? 'Paste the token first.' : problem ? true : undefined"
    >
      <UInput
        v-model="token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        data-1p-ignore
        data-lpignore="true"
        class="w-full"
        :autofocus="autofocus"
        :disabled="busy"
        :aria-describedby="problem ? 'vitehub-project-token-problem' : undefined"
      />
    </UFormField>
    <ConsoleProjectProblemAlert v-if="problem && !empty" id="vitehub-project-token-problem" :problem="problem" />
    <UButton type="submit" block :loading="busy" :label="busy ? 'Signing in…' : 'Sign in'" />
  </form>
</template>
