<script setup lang="ts">
import type { AttachmentMediaProps, AttachmentMediaSlots } from "./types.ts";

const { kind = "icon" } = defineProps<AttachmentMediaProps>();
defineSlots<AttachmentMediaSlots>();
</script>

<template>
  <div data-slot="attachment-media" :data-kind="kind"><slot /></div>
</template>
