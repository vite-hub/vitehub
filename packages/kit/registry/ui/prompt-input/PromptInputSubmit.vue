<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { ArrowUpIcon, SquareIcon } from "@lucide/vue";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePromptInput } from "./utils";

const props = withDefaults(defineProps<{ label?: string; stopLabel?: string; class?: HTMLAttributes["class"] }>(), {
  label: "Send",
  stopLabel: "Stop",
});
const { pending, canSubmit, stop } = usePromptInput();
</script>

<template>
  <button
    :type="pending ? 'button' : 'submit'"
    data-slot="prompt-input-submit"
    :data-pending="pending ? '' : undefined"
    :aria-label="pending ? props.stopLabel : props.label"
    :disabled="!pending && !canSubmit"
    :class="cn(buttonVariants({ size: 'icon-sm' }), 'ms-auto', props.class)"
    @click="pending && stop()"
  >
    <SquareIcon v-if="pending" aria-hidden="true" class="size-3 fill-current" />
    <ArrowUpIcon v-else aria-hidden="true" />
  </button>
</template>
