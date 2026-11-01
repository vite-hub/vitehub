<script setup lang="ts">
const config = useSafeRuntimeConfig()
const base = config.public.apiBase
const rate = useSafeRuntimeConfig().public.sampleRate
</script>

<template>
  <p>{{ base }} {{ rate }}</p>
</template>
