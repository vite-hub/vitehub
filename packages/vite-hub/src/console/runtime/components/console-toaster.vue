<script setup lang="ts">
import { ToastAction, ToastClose, ToastPortal, ToastProvider, ToastRoot, ToastTitle, ToastViewport } from "reka-ui";
import { onBeforeUnmount, ref } from "vue";

import { useConsoleToast } from "../client/toast";

import type { ConsoleToast } from "../client/toast";

/**
 * Renders Console toasts at the bottom right (Geist toast material: 12px radius, menu shadow, 420px wide). Reka pauses
 * the timer while the pointer or focus is on a toast and while the window is in the background. F8 focuses the region.
 */
const { remove, toasts } = useConsoleToast();
// A closed toast stays mounted for its exit animation, then leaves the list.
const closed = ref(new Set<number>());
const timers = new Set<ReturnType<typeof setTimeout>>();

function close(id: number): void {
  if (closed.value.has(id)) return;
  closed.value = new Set(closed.value).add(id);
  const timer = setTimeout(() => {
    timers.delete(timer);
    remove(id);
    const next = new Set(closed.value);
    next.delete(id);
    closed.value = next;
  }, 200);
  timers.add(timer);
}

async function act(toast: ConsoleToast): Promise<void> {
  close(toast.id);
  await toast.action?.onClick();
}

onBeforeUnmount(() => {
  for (const timer of timers) clearTimeout(timer);
});
</script>

<template>
  <ToastProvider swipe-direction="right" label="Console notifications">
    <ToastRoot
      v-for="toast in toasts"
      :key="toast.id"
      :open="!closed.has(toast.id)"
      :duration="toast.duration"
      :type="toast.error ? 'foreground' : 'background'"
      class="pointer-events-auto flex min-h-12 w-full items-center gap-2.5 rounded-xl bg-default py-2 ps-4 pe-2 text-sm text-highlighted shadow-[0_1px_1px_rgb(0_0_0/2%),0_4px_8px_-4px_rgb(0_0_0/4%),0_16px_24px_-8px_rgb(0_0_0/6%)] ring ring-default data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform data-[swipe=move]:translate-x-(--reka-toast-swipe-move-x) motion-safe:data-[state=closed]:animate-[vitehub-console-toast-out_150ms_ease-out] motion-safe:data-[state=open]:animate-[vitehub-console-toast-in_200ms_cubic-bezier(.25,.75,.6,.98)] motion-safe:data-[swipe=end]:animate-[vitehub-console-toast-out_100ms_ease-out]"
      @update:open="(open) => { if (!open) close(toast.id) }"
    >
      <UIcon v-if="toast.error" name="i-lucide-circle-alert" class="size-4 shrink-0 text-error" aria-hidden="true" />
      <ToastTitle class="min-w-0 flex-1 py-1">{{ toast.title }}</ToastTitle>
      <ToastAction v-if="toast.action" :alt-text="`${toast.action.label}: ${toast.title}`" as-child>
        <UButton variant="outline" size="xs" :label="toast.action.label" @click.stop="act(toast)" />
      </ToastAction>
      <ToastClose as-child>
        <UButton variant="ghost" size="xs" icon="i-lucide-x" aria-label="Dismiss" class="text-muted" />
      </ToastClose>
    </ToastRoot>

    <ToastPortal>
      <ToastViewport class="fixed end-4 bottom-4 z-[100] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2 outline-none sm:end-6 sm:bottom-6" />
    </ToastPortal>
  </ToastProvider>
</template>
