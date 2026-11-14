<script setup lang="ts">
import { defineShortcuts } from "@nuxt/ui/composables";
import { defineAsyncComponent, ref, watch } from "vue";

import { consoleSearchRequests } from "../client/sidebar";

// The palette carries the command palette, fuzzy search, and the list virtualizer of Nuxt UI, so it loads when search
// first opens instead of with every Console page. Props and listeners fall through to it.
const ConsoleSearchPalette = defineAsyncComponent(() => import("./console-search-palette.vue"));

const open = ref(false);
const requested = ref(false);

function show(): void {
  requested.value = true;
  open.value = true;
}

// The Search row of the sidebar. Once the palette loads, its UDashboardSearch also handles ⌘K. Until then, ⌘K loads it.
watch(consoleSearchRequests, show);
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
