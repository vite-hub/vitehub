<script setup lang="ts">
const config = useSafeRuntimeConfig()
const apiBase = config.public.apiBase
</script>

<template>
  <main>API base: {{ apiBase }}</main>
</template>
