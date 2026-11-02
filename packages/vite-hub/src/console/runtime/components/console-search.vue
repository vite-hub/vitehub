<script setup lang="ts">
import { defineShortcuts } from "@nuxt/ui/composables";
import { useRuntimeHook } from "#imports";
import { defineAsyncComponent, ref } from "vue";

// The palette carries the command palette, fuzzy search, and the list virtualizer of Nuxt UI, so it loads when search
// first opens instead of with every Console page. Props and listeners fall through to it.
const ConsoleSearchPalette = defineAsyncComponent(() => import("./console-search-palette.vue"));

const open = ref(false);
const requested = ref(false);

function show(): void {
  requested.value = true;
  open.value = true;
}

// Once the palette loads, its UDashboardSearch handles ⌘K and the rail search button. Until then, they load it.
useRuntimeHook("dashboard:search:toggle", () => {
  if (!requested.value) show();
});
defineShortcuts({
  // `/` opens search, as in GitHub and Linear. It does not run while an input has focus.
  "/": show,
  meta_k: {
    usingInput: true,
    handler: () => {
      if (!requested.value) show();
    },
  },
});
</script>

<template>
  <ConsoleSearchPalette v-if="requested" v-model:open="open" />
</template>
