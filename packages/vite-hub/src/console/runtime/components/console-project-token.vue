<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { ConsoleProjectProblem } from "../client/project-link";
import ConsoleProjectProblemAlert from "./console-project-problem.vue";

const props = defineProps<{
  /** Why the last token did not open the project. */
  problem?: ConsoleProjectProblem;
  busy?: boolean;
}>();

const emit = defineEmits<{ submit: [token: string] }>();

const token = ref("");
const empty = ref(false);
// A changed token was not checked yet, so the problem of the last one hides until the next answer.
const edited = ref(false);
// A touch screen keeps its keyboard closed until the person taps the field.
const autofocus = !("ontouchstart" in window);
const shown = computed<ConsoleProjectProblem | undefined>(() => empty.value
  ? { title: "Paste the token first", message: "" }
  : edited.value ? undefined : props.problem);

watch(token, () => {
  empty.value = false;
  edited.value = true;
});
watch(() => props.problem, () => {
  edited.value = false;
});

function submit(): void {
  if (props.busy) return;
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
      :error="shown ? true : undefined"
      :ui="{ error: 'mt-3' }"
    >
      <!-- Read-only, not disabled, while the check runs, so the field keeps focus for the next try. -->
      <UInput
        v-model="token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        data-1p-ignore
        data-lpignore="true"
        class="w-full"
        :autofocus="autofocus"
        :readonly="busy"
      />
      <template v-if="shown" #error>
        <ConsoleProjectProblemAlert :problem="shown" />
      </template>
    </UFormField>
    <UButton type="submit" block :loading="busy" :label="busy ? 'Signing in…' : 'Sign in'" />
  </form>
</template>
