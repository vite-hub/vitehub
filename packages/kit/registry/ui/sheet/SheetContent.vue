<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { XIcon } from "@lucide/vue";
import { DrawerBackdrop, DrawerClose, DrawerContent } from "@ui-sdk/vue/drawer";
import { cn } from "@/lib/utils";

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ class?: HTMLAttributes["class"]; showClose?: boolean }>(), { showClose: true });
</script>

<template>
  <DrawerBackdrop class="fixed inset-0 z-50 bg-overlay" />
  <DrawerContent
    v-bind="$attrs"
    :class="cn(
      'relative flex flex-col gap-4 overflow-y-auto overscroll-contain bg-background p-5 text-sm text-foreground shadow-dialog outline-none',
      'data-[side=left]:h-full data-[side=left]:w-80 data-[side=left]:max-w-[85vw] data-[side=right]:h-full data-[side=right]:w-80 data-[side=right]:max-w-[85vw]',
      'data-[side=bottom]:mx-auto data-[side=bottom]:max-h-[85dvh] data-[side=bottom]:w-full data-[side=bottom]:max-w-lg data-[side=bottom]:rounded-t-xl data-[side=bottom]:pb-[max(1.25rem,env(safe-area-inset-bottom))]',
      'data-[side=top]:mx-auto data-[side=top]:max-h-[85dvh] data-[side=top]:w-full data-[side=top]:max-w-lg data-[side=top]:rounded-b-xl',
      props.class,
    )"
  >
    <slot />
    <DrawerClose
      v-if="props.showClose"
      aria-label="Close"
      class="absolute end-3 top-3 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4"
    >
      <XIcon aria-hidden="true" />
    </DrawerClose>
  </DrawerContent>
</template>
