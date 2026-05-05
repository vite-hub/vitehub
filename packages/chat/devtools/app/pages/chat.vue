<script setup lang="ts">
definePageMeta({
  layout: false,
})
</script>

<template>
  <ClientOnly>
    <UApp>
      <ChatDevtools />
    </UApp>
  </ClientOnly>
</template>
