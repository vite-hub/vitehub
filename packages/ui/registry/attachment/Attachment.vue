<script setup lang="ts">
import "../core/vitehub.css";
import "./attachment.css";
import type { AttachmentProps, AttachmentSlots } from "./types.ts";

const { status = "done", size = "md", orientation = "horizontal" } = defineProps<AttachmentProps>();
defineSlots<AttachmentSlots>();
</script>

<template>
  <div data-slot="attachment" :data-status="status" :data-size="size" :data-orientation="orientation"><slot /></div>
</template>
