<script setup lang="ts">
import { ToastAction, ToastClose, ToastPortal, ToastProvider, ToastRoot, ToastTitle, ToastViewport } from "reka-ui";
import { ref } from "vue";

const open = ref(false);
</script>

<template>
  <!-- As in the Console toaster: a labelled provider that swipes right, and a viewport in a portal. -->
  <ToastProvider label="Notifications" swipe-direction="right">
    <button type="button" @click="open = true">Show toast</button>
    <ToastRoot v-model:open="open" :duration="600_000" style="display: flex; gap: 8px; width: 280px; padding: 8px; background: white">
      <ToastTitle>File saved</ToastTitle>
      <ToastAction alt-text="Undo: File saved">Undo</ToastAction>
      <ToastClose>Dismiss</ToastClose>
    </ToastRoot>
    <ToastPortal>
      <ToastViewport style="position: fixed; right: 16px; bottom: 16px; margin: 0; padding: 0; list-style: none" />
    </ToastPortal>
  </ToastProvider>
  <button type="button">After</button>
</template>
