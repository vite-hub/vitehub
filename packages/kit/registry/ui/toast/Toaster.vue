<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { XIcon } from "@lucide/vue";
import { Toast, ToastAction, ToastClose, ToastDescription, ToastRegion, ToastTitle } from "@ui-sdk/vue/toast";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <ToastRegion
    :class="cn(
      'group/toaster m-4 h-(--toast-front-height) w-88 max-w-[calc(100vw-2rem)] overflow-visible border-0 bg-transparent p-0',
      'data-expanded:h-[calc(var(--toast-stack-height)+(var(--toast-count)-1)*0.5rem)]',
      props.class,
    )"
  >
    <Toast
      :class="cn(
        'group/toast flex items-start gap-3 rounded-xl bg-popover p-3 ps-4 text-sm text-popover-foreground shadow-popover backdrop-blur-xl select-none',
        'absolute inset-x-0 bottom-0 z-[calc(100-var(--toast-index))] h-(--toast-height) overflow-hidden [--gap:0.5rem] [--y:calc(var(--toast-index)*-0.5rem)]',
        '[translate:var(--toast-swipe-x,0px)_calc(var(--y)+var(--toast-swipe-y,0px))] [scale:calc(1-var(--toast-index)*0.05)]',
        'transition-[translate,scale,opacity,height] duration-400 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-opacity',
        'not-data-front:not-data-expanded:h-(--toast-front-height)',
        'data-expanded:[scale:1] data-expanded:[--y:calc(-1*(var(--toast-offset)+var(--toast-index)*var(--gap)))]',
        'group-data-[side=top]/toaster:top-0 group-data-[side=top]/toaster:bottom-auto group-data-[side=top]/toaster:[--y:calc(var(--toast-index)*0.5rem)]',
        'group-data-[side=top]/toaster:data-expanded:[--y:calc(var(--toast-offset)+var(--toast-index)*var(--gap))]',
        'data-starting-style:transition-none data-swiping:transition-none',
        'data-starting-style:data-front:[--y:100%] group-data-[side=top]/toaster:data-starting-style:data-front:[--y:-100%]',
        'data-starting-style:not-data-front:opacity-0 data-ending-style:opacity-0',
      )"
    >
      <div class="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        <ToastTitle class="m-0 font-medium group-data-[type=error]/toast:text-vh-text-error group-data-[type=success]/toast:text-vh-text-success group-data-[type=warning]/toast:text-vh-text-warning" />
        <ToastDescription class="m-0 text-muted-foreground empty:hidden" />
      </div>
      <ToastAction class="inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 empty:hidden" />
      <ToastClose aria-label="Dismiss" class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5">
        <XIcon aria-hidden="true" />
      </ToastClose>
    </Toast>
  </ToastRegion>
</template>
