<script setup lang="ts">
definePageMeta({ layout: 'app' })

const { user, fetchSession } = useUserSession()
await fetchSession({ force: true })
</script>

<template>
  <h1>Hello {{ user?.name }}</h1>
</template>
