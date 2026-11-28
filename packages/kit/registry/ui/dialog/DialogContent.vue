<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { XIcon } from "@lucide/vue";
import { DialogBackdrop, DialogClose, DialogContent as DialogContentPart } from "@ui-sdk/vue/dialog";
import { cn } from "@/lib/utils";

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ class?: HTMLAttributes["class"]; showClose?: boolean }>(), { showClose: true });
</script>

<template>
  <DialogBackdrop class="fixed inset-0 z-50 bg-overlay" />
  <DialogContentPart
    v-bind="$attrs"
    :class="cn('fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100%-2rem))] flex-col gap-4 overflow-y-auto overscroll-contain rounded-xl border-0 bg-popover p-5 text-sm text-popover-foreground shadow-dialog outline-none backdrop-blur-xl', props.class)"
  >
    <slot />
    <DialogClose
      v-if="props.showClose"
      aria-label="Close"
      class="absolute end-3 top-3 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4"
    >
      <XIcon aria-hidden="true" />
    </DialogClose>
  </DialogContentPart>
</template>
