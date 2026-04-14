<script setup lang="ts">
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
