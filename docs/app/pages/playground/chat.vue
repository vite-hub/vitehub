<script setup lang="ts">
definePageMeta({
  layout: false,
})
</script>

<template>
  <ClientOnly>
    <UApp>
      <PlaygroundChatDevtools />
    </UApp>
  </ClientOnly>
</template>
