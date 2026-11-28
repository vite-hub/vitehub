<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { CommandShortcut as CommandShortcutPart } from "@ui-sdk/vue/command";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <CommandShortcutPart :class="cn('ms-auto text-xs tracking-widest text-muted-foreground', props.class)">
    <slot />
  </CommandShortcutPart>
</template>
