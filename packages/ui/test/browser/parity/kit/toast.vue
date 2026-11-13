<script setup lang="ts">
import { createToaster, Toast, ToastAction, ToastClose, ToastRegion, ToastTitle } from "@vite-hub/kit/toast";

// As in the Console toaster: one queue, and a labelled region at the bottom right in a portal, where toasts swipe right.
// F8 focuses the region, as in Reka. ui-sdk defaults to F6.
const toaster = createToaster();
const show = () => toaster({ title: "File saved", duration: 600_000, action: { label: "Undo", onAction: () => {} } });
const body = document.body;
</script>

<template>
  <button type="button" @click="show">Show toast</button>
  <ToastRegion :toaster="toaster" :container="body" aria-label="Notifications" shortcut="F8" side="bottom" align="end" style="position: fixed; right: 16px; bottom: 16px; margin: 0; padding: 0">
    <Toast style="display: flex; gap: 8px; width: 280px; padding: 8px; background: white; list-style: none">
      <ToastTitle />
      <ToastAction />
      <ToastClose>Dismiss</ToastClose>
    </Toast>
  </ToastRegion>
  <button type="button">After</button>
</template>
