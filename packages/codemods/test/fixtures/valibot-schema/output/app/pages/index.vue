<script setup lang="ts">
import { usePublicEnv } from "#vitehub/env/public"

const config = usePublicEnv()
const base = config.apiBase
const rate = usePublicEnv().sampleRate
</script>

<template>
  <p>{{ base }} {{ rate }}</p>
</template>
