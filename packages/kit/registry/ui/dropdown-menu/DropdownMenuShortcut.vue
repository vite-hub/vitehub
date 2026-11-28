<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { MenuShortcut as MenuShortcutPart } from "@ui-sdk/vue/menu";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <MenuShortcutPart :class="cn('ms-auto text-xs tracking-widest text-muted-foreground', props.class)">
    <slot />
  </MenuShortcutPart>
</template>
