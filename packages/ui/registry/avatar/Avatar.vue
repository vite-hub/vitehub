<script setup lang="ts">
import "../core/vitehub.css";
import "./avatar.css";
import { Avatar as AvatarPart } from "@ui-sdk/vue/avatar";
import AvatarFallback from "./AvatarFallback.vue";
import AvatarImage from "./AvatarImage.vue";
import type { AvatarProps, AvatarSlots } from "./types.ts";

const { size = "md", src, alt, fallback } = defineProps<AvatarProps>();
defineSlots<AvatarSlots>();
</script>

<template>
  <AvatarPart data-slot="avatar" :data-size="size">
    <slot>
      <AvatarImage v-if="src" :src="src" :alt="alt ?? ''" />
      <AvatarFallback>{{ fallback }}</AvatarFallback>
    </slot>
  </AvatarPart>
</template>
