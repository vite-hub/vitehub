<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { deleteConsoleInvocation, startConsoleAgentInvocation } from "../client/invocation";

export type ConsoleSessionRerun =
  | { available: true; invokerProfileId?: string; prompt: string }
  | { available: false; reason: string };

const props = defineProps<{
  agent: string;
  agentsBase: string;
  apiBase: string;
  deletable: boolean;
  deleteUnavailableReason?: string;
  id: string;
  rerun: ConsoleSessionRerun;
}>();

const emit = defineEmits<{
  deleted: [id: string];
  started: [invocation: { agent: string; id: string }];
}>();

const pending = ref<"delete" | "rerun">();
const error = ref<string>();
const confirmOpen = ref(false);

const rerunUnavailable: Record<string, string> = {
  "invocation-not-terminal": "Rerun is available after the session finishes",
  "replay-metadata-unavailable": "Rerun is unavailable: the session has no complete replay metadata",
  "input-has-context": "Rerun is unavailable: this session received trusted invocation context",
  "input-has-run-metadata": "Rerun is unavailable: this session received runtime run metadata",
  "input-has-abort-signal": "Rerun is unavailable: this session received a cancellation signal",
  "input-prompt-changed": "Rerun is unavailable: input preparation changed the prompt",
  "input-has-dry-run": "Rerun is unavailable: this session ran in dry-run mode",
  "input-has-timeout": "Rerun is unavailable: this session received a timeout",
  "input-has-invoker": "Rerun is unavailable: this session received a direct invoker identity",
  "input-has-options": "Rerun is unavailable: this session received call options",
  "input-has-data": "Rerun is unavailable: this session received structured input",
  "input-redacted": "Rerun is unavailable: the recorded input or Invoker Profile was redacted",
  "input-has-messages": "Rerun is unavailable: this session received messages or attachments",
  "input-not-captured": "Rerun is unavailable: the prompt was not recorded",
  "input-truncated": "Rerun is unavailable: the recorded prompt is incomplete",
  "invoker-profile-unavailable": "Rerun is unavailable: the recorded Invoker Profile is no longer configured",
};
const rerunLabel = computed(() => {
  if (props.rerun.available) return "Rerun with the same prompt";
  return rerunUnavailable[props.rerun.reason] ?? "Rerun is unavailable for this session";
});
const deleteLabel = computed(() =>
  props.deletable ? "Delete session" : props.deleteUnavailableReason === "store-delete-unavailable"
    ? "Delete is unavailable: the invocation store does not support deletion"
    : "Delete is available after the session finishes",
);

watch(
  () => props.id,
  () => {
    error.value = undefined;
    confirmOpen.value = false;
  },
);

function message(value: unknown, fallback: string): string {
  return value instanceof Error && value.message ? value.message : fallback;
}

async function rerunInvocation(): Promise<void> {
  if (pending.value || !props.rerun.available) return;
  const { agent, id } = props;
  pending.value = "rerun";
  error.value = undefined;
  try {
    const started = await startConsoleAgentInvocation(
      { agent, base: props.agentsBase, invokerProfileId: props.rerun.invokerProfileId },
      { text: props.rerun.prompt },
    );
    if (props.id === id) emit("started", started);
  } catch (value) {
    if (props.id === id) error.value = message(value, "The session could not be rerun.");
  } finally {
    pending.value = undefined;
  }
}

async function deleteInvocation(): Promise<void> {
  if (pending.value || !props.deletable) return;
  const { id } = props;
  pending.value = "delete";
  error.value = undefined;
  try {
    await deleteConsoleInvocation(props.apiBase, id);
    confirmOpen.value = false;
    emit("deleted", id);
  } catch (value) {
    if (props.id === id) error.value = message(value, "The session could not be deleted.");
  } finally {
    pending.value = undefined;
  }
}
</script>

<template>
  <span
    v-if="error"
    data-slot="session-action-error"
    role="alert"
    class="max-w-56 truncate text-xs text-error"
    :title="error"
  >{{ error }}</span>
  <UTooltip :text="rerunLabel">
    <UButton
      data-slot="session-rerun"
      icon="i-lucide-rotate-ccw"
      color="neutral"
      variant="ghost"
      size="xs"
      :disabled="!props.rerun.available || Boolean(pending)"
      :aria-label="rerunLabel"
      @click="rerunInvocation"
    />
  </UTooltip>
  <UPopover
    v-model:open="confirmOpen"
    :content="{ align: 'end', collisionPadding: 12 }"
    :ui="{ content: 'w-64 max-w-[calc(100vw-1.5rem)] p-3' }"
  >
    <UTooltip :text="deleteLabel">
      <UButton
        data-slot="session-delete"
        icon="i-lucide-trash-2"
        color="neutral"
        variant="ghost"
        size="xs"
        :disabled="!deletable || Boolean(pending)"
        :aria-label="deleteLabel"
      />
    </UTooltip>
    <template #content>
      <div class="grid gap-3">
        <p class="text-sm">Delete this session and its usage record?</p>
        <div class="flex justify-end gap-1">
          <UButton color="neutral" label="Cancel" size="xs" variant="ghost" @click="confirmOpen = false" />
          <UButton
            data-slot="session-delete-confirm"
            color="error"
            label="Delete"
            size="xs"
            variant="soft"
            :disabled="Boolean(pending)"
            @click="deleteInvocation"
          />
        </div>
      </div>
    </template>
  </UPopover>
</template>
