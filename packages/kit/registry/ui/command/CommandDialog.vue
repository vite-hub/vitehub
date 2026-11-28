<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Command } from "@ui-sdk/vue/command";
import { Dialog, DialogBackdrop, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/vue/dialog";
import { cn } from "@/lib/utils";

const props = withDefaults(defineProps<{ title?: string; description?: string; class?: HTMLAttributes["class"] }>(), {
  title: "Command palette",
  description: "Search for a command to run.",
});
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ action: [value: string] }>();

function run(value: string) {
  emit("action", value);
  open.value = false;
}
</script>

<template>
  <Dialog v-model:open="open">
    <slot name="trigger" />
    <DialogBackdrop class="fixed inset-0 z-50 bg-overlay" />
    <DialogContent
      :class="cn('fixed inset-x-0 top-[12dvh] z-50 mx-auto flex h-fit max-h-[min(28rem,76dvh)] w-[min(32rem,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border-0 bg-popover p-0 text-sm text-popover-foreground shadow-dialog outline-none backdrop-blur-xl', props.class)"
    >
      <DialogTitle class="sr-only">{{ props.title }}</DialogTitle>
      <DialogDescription class="sr-only">{{ props.description }}</DialogDescription>
      <Command class="flex min-h-0 flex-1 flex-col" @action="run">
        <slot />
      </Command>
    </DialogContent>
  </Dialog>
</template>
