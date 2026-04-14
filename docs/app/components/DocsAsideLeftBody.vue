<script setup lang="ts">
import { useDocsNavigation } from "~/composables/useDocsNavigation";
import { useFrameworkPreference } from "~/composables/useFrameworkPreference";

const { sidebarNavigation } = useDocsNavigation();
const { current } = useFrameworkPreference();
</script>

<template>
  <UContentNavigation
    :key="current"
    highlight
    :navigation="sidebarNavigation"
  />
</template>
