<script setup lang="ts">
defineProps<{ error: { statusCode?: number, message?: string } }>()
</script>

<template>
  <p class="p-6 text-sm">
    {{ error.statusCode }} {{ error.message }}
  </p>
</template>
