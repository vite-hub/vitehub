<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { cancelConsoleInvocation } from "../client/invocation";

const props = defineProps<{
  apiBase: string;
  cancelRequested: boolean;
  id: string;
  notEnforcedBy?: string;
  terminal: boolean;
}>();

const emit = defineEmits<{
  cancelled: [id: string];
}>();

const pending = ref(false);
const error = ref<string>();
const notEnforcedBy = ref<string>();
const terminalNotice = ref<string>();
const notice = computed(() => {
  if (props.terminal) return terminalNotice.value;
  const driver = notEnforcedBy.value ?? (props.cancelRequested ? props.notEnforcedBy : undefined);
  if (driver) return `Cancel requested, not enforced by ${driver}`;
  return props.cancelRequested ? "Cancellation requested; completion not confirmed" : undefined;
});
const label = computed(() =>
  props.terminal ? "Abort stale execution" : props.cancelRequested ? "Cancel requested" : "Cancel session",
);

watch(
  () => props.id,
  () => {
    error.value = undefined;
    notEnforcedBy.value = undefined;
    terminalNotice.value = undefined;
  },
);

async function cancelInvocation(): Promise<void> {
  if (pending.value || (!props.terminal && props.cancelRequested)) return;
  const { id } = props;
  pending.value = true;
  error.value = undefined;
  try {
    const result = await cancelConsoleInvocation(props.apiBase, id);
    if (props.id !== id) return;
    notEnforcedBy.value = result.notEnforcedBy;
    if (result.outcome === "terminal") {
      terminalNotice.value = result.delivery === "local"
        ? result.notEnforcedBy
          ? `Local abort requested, not enforced by ${result.notEnforcedBy}`
          : "Local abort requested; completion not confirmed"
        : "Journal is terminal; no local execution received an abort";
    }
    emit("cancelled", id);
  } catch (value) {
    if (props.id === id) {
      error.value = value instanceof Error && value.message ? value.message : "The session could not be cancelled.";
    }
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <span
    v-if="error || notice"
    data-slot="session-cancel-status"
    :role="error ? 'alert' : 'status'"
    class="max-w-64 truncate text-xs"
    :class="error ? 'text-error' : 'text-warning'"
    :title="error ?? notice"
  >{{ error ?? notice }}</span>
  <UTooltip :text="label">
    <UButton
      data-slot="session-cancel"
      icon="i-lucide-circle-stop"
      color="neutral"
      variant="ghost"
      size="xs"
      :loading="pending"
      :disabled="pending || (!terminal && cancelRequested)"
      :aria-label="label"
      @click="cancelInvocation"
    />
  </UTooltip>
</template>
