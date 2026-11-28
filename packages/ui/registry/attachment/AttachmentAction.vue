<script setup lang="ts">
import { X } from "@lucide/vue";
import type { AttachmentActionProps, AttachmentActionSlots } from "./types.ts";

const { label = "Remove", disabled = false } = defineProps<AttachmentActionProps>();
defineSlots<AttachmentActionSlots>();
</script>

<template>
  <button type="button" data-slot="attachment-action" :aria-label="label" :disabled="disabled">
    <slot><X aria-hidden="true" /></slot>
  </button>
</template>
