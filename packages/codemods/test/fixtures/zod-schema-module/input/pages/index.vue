<script setup lang="ts">
const runtime = useRuntimeConfig()
const site = runtime.public.siteName
const appBase = runtime.app.baseURL
</script>

<template>
  <h1>{{ site }} {{ appBase }}</h1>
</template>
