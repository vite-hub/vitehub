<script setup lang="ts">
import "../core/vitehub.css";
import "./message.css";
import type { MessageProps, MessageSlots } from "./types.ts";

const { align = "start" } = defineProps<MessageProps>();
defineSlots<MessageSlots>();
</script>

<template>
  <div data-slot="message" :data-align="align"><slot /></div>
</template>
