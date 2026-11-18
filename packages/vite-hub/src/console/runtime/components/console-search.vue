<script setup lang="ts">
import { useShortcut } from "@ui-sdk/vue/shortcuts";
import { defineAsyncComponent, ref, watch } from "vue";

import { consoleSearchRequests } from "../client/sidebar";

// The palette carries the command list, fuzzy search, and the search requests, so it loads when search first opens
// instead of with every Console page. Props and listeners fall through to it.
const ConsoleSearchPalette = defineAsyncComponent(() => import("./console-search-palette.vue"));

const open = ref(false);
const requested = ref(false);

function show(): void {
  requested.value = true;
  open.value = true;
}

// The Search row of the sidebar. While search is open, the palette closes it on ⌘K.
watch(consoleSearchRequests, show);
// `/` opens search, as in GitHub and Linear. It does not run while a field has focus.
useShortcut("/", show, { description: "Search the Console" });
useShortcut("mod+k", show, { allowInInput: true, description: "Search the Console" });
</script>

<template>
  <ConsoleSearchPalette v-if="requested" v-model:open="open" />
</template>
