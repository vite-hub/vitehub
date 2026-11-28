<script setup lang="ts">
import { AvatarImage as AvatarImagePart } from "@ui-sdk/vue/avatar";
import type { AvatarImageProps } from "./types.ts";

const { src, alt = "" } = defineProps<AvatarImageProps>();
</script>

<template>
  <AvatarImagePart data-slot="avatar-image" :src="src" :alt="alt" />
</template>
