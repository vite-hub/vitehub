<script setup lang="ts">
import { AvatarFallback as AvatarFallbackPart } from "@ui-sdk/vue/avatar";
import type { AvatarFallbackSlots } from "./types.ts";

defineSlots<AvatarFallbackSlots>();
</script>

<template>
  <AvatarFallbackPart data-slot="avatar-fallback"><slot /></AvatarFallbackPart>
</template>
