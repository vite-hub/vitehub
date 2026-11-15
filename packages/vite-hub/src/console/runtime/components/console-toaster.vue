<script setup lang="ts">
import { createToaster, Toast, ToastAction, ToastClose, ToastRegion, ToastTitle } from "@ui-sdk/vue/toast";
import { watch } from "vue";

import { useConsoleToast } from "../client/toast";

/**
 * Renders Console toasts at the bottom right (Geist toast material: 12px radius, menu shadow, 420px wide). The kit
 * pauses the timer while the pointer or focus is on a toast and while the window is in the background. F8 focuses the
 * region. The Console list in `client/toast.ts` stays the source: each new toast goes to the kit toaster, and a toast
 * that closes leaves the list.
 */
const { remove, toasts } = useConsoleToast();
const toaster = createToaster();
const shown = new Set<number>();

watch(toasts, (list) => {
  const current = new Set(list.map(toast => toast.id));
  for (const toast of list) {
    if (shown.has(toast.id)) continue;
    shown.add(toast.id);
    const { action } = toast;
    toaster({
      id: String(toast.id),
      title: toast.title,
      duration: toast.duration,
      type: toast.error ? "error" : "default",
      // The toast closes when the action starts, as before, so a slow action does not hold it open.
      action: action && { label: action.label, onAction: () => { void action.onClick(); } },
      onDismiss: () => {
        shown.delete(toast.id);
        remove(toast.id);
      },
    });
  }
  // A toast that left the list, such as the oldest of four, closes here too.
  for (const id of shown) {
    if (current.has(id)) continue;
    shown.delete(id);
    toaster.dismiss(String(id));
  }
}, { immediate: true });
</script>

<template>
  <ToastRegion
    :toaster="toaster"
    aria-label="Console notifications"
    shortcut="F8"
    side="bottom"
    align="end"
    expanded
    class="fixed end-4 bottom-4 z-[100] w-[min(420px,calc(100vw-2rem))] outline-none sm:end-6 sm:bottom-6 [&>ol]:flex [&>ol]:flex-col-reverse [&>ol]:gap-2"
  >
    <template #default="{ toast }">
      <Toast
        class="pointer-events-auto flex min-h-12 w-full items-center gap-2.5 rounded-xl bg-default py-2 ps-4 pe-2 text-sm text-highlighted shadow-(--vh-shadow-floating) data-swiping:translate-x-(--toast-swipe-x) motion-safe:animate-[vitehub-console-toast-in_200ms_cubic-bezier(.25,.75,.6,.98)] motion-safe:data-ending-style:animate-[vitehub-console-toast-out_150ms_ease-out] motion-safe:data-swipe-direction:animate-[vitehub-console-toast-out_100ms_ease-out]"
      >
        <UIcon v-if="toast.type === 'error'" name="i-lucide-circle-alert" class="size-4 shrink-0 text-error" aria-hidden="true" />
        <ToastTitle class="min-w-0 flex-1 py-1" />
        <ToastAction>
          <template #render="{ props }">
            <UButton v-bind="props" variant="outline" size="xs" :label="toast.action?.label" />
          </template>
        </ToastAction>
        <ToastClose>
          <template #render="{ props }">
            <UButton v-bind="props" variant="ghost" size="xs" icon="i-lucide-x" aria-label="Dismiss" class="text-muted" />
          </template>
        </ToastClose>
      </Toast>
    </template>
  </ToastRegion>
</template>
