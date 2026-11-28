<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { AvatarImage as AvatarImagePart } from "@ui-sdk/vue/avatar";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <AvatarImagePart :class="cn('aspect-square size-full object-cover', props.class)" />
</template>
