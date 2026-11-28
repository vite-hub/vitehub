<script setup lang="ts">
import "../core/vitehub.css";
import "./toast.css";
import { X } from "@lucide/vue";
import { Toast, ToastAction, ToastClose, ToastDescription, ToastRegion, ToastTitle } from "@ui-sdk/vue/toast";
import type { ToasterProps, ToasterSlots } from "./types.ts";

const { toaster, side = "bottom", closeLabel = "Dismiss" } = defineProps<ToasterProps>();
defineSlots<ToasterSlots>();
</script>

<template>
  <!-- ui-sdk finds the region by `toast-region`, so the region keeps that name. -->
  <ToastRegion data-slot="toast-region" :toaster="toaster" :side="side">
    <slot>
      <Toast data-slot="toast">
        <div data-slot="toast-content">
          <ToastTitle data-slot="toast-title" />
          <ToastDescription data-slot="toast-description" />
        </div>
        <ToastAction data-slot="toast-action" />
        <ToastClose data-slot="toast-close" :aria-label="closeLabel"><X aria-hidden="true" /></ToastClose>
      </Toast>
    </slot>
  </ToastRegion>
</template>
