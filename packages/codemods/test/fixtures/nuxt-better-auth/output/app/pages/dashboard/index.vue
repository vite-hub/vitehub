<script setup lang="ts">
definePageMeta({ auth: 'user', layout: 'app' })

const { user, fetchSession } = useUserSession()
await fetchSession({ force: true })
</script>

<template>
  <h1>Hello {{ user?.name }}</h1>
</template>
