<script setup lang="ts">
import { ArrowUp, LoaderCircle, RefreshCw, Square } from "@lucide/vue";
import { computed, useAttrs } from "vue";
import { usePromptInput } from "./context.ts";
import type { PromptInputSubmitSlots } from "./types.ts";

defineOptions({ inheritAttrs: false });
defineSlots<PromptInputSubmitSlots>();
const attrs = useAttrs();
const context = usePromptInput();

const labels = { error: "Retry prompt", ready: "Send prompt", streaming: "Stop response", submitted: "Stop response" } as const;
const status = computed(() => context?.status.value ?? "ready");
const label = computed(() => (status.value === "ready" && context?.submitLabel.value) || labels[status.value]);
// Stop and Retry stay pressable while files are read; only Send waits for them.
const loading = computed(() => status.value === "ready" && Boolean(context?.preparing.value || context?.readonly.value));
// Stop stays pressable, so a running reply can end.
const inactive = computed(() => (status.value === "ready" && !context?.canSubmit.value) || (status.value === "error" && Boolean(context?.disabled.value)));
// Solid once there is something to send, so an empty box does not end in a dark button.
const variant = computed(() => (status.value === "ready" && !context?.canSubmit.value ? "soft" : "solid"));
const scope = computed(() => ({ canSubmit: context?.canSubmit.value ?? false, preparing: context?.preparing.value ?? false, status: status.value }));
</script>

<template>
  <template v-if="context">
    <!-- The spacer puts the submit button at the end of the toolbar. -->
    <span data-slot="prompt-input-spacer" />
    <button
      v-bind="attrs"
      type="button"
      data-slot="prompt-input-submit"
      :data-status="status"
      :data-variant="variant"
      :data-loading="loading ? '' : undefined"
      :aria-label="label"
      :disabled="inactive || loading"
      @click="context.press()"
    >
      <LoaderCircle v-if="loading" data-slot="prompt-input-submit-icon" aria-hidden="true" />
      <slot v-else v-bind="scope">
        <ArrowUp v-if="status === 'ready'" data-slot="prompt-input-submit-icon" aria-hidden="true" />
        <RefreshCw v-else-if="status === 'error'" data-slot="prompt-input-submit-icon" aria-hidden="true" />
        <Square v-else data-slot="prompt-input-submit-icon" aria-hidden="true" />
      </slot>
    </button>
  </template>
</template>
