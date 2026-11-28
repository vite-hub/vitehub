<script setup lang="ts">
import "../core/vitehub.css";
import "./kbd.css";
import type { KbdProps, KbdSlots } from "./types.ts";

const { size = "md", label } = defineProps<KbdProps>();
defineSlots<KbdSlots>();
</script>

<template>
  <kbd data-slot="kbd" :data-size="size"><slot>{{ label }}</slot></kbd>
</template>
