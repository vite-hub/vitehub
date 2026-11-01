<script setup>
const config = useSafeRuntimeConfig()
</script>

<template>
  <footer>{{ config.public.siteName }} {{ $config.public.siteName }}</footer>
</template>
