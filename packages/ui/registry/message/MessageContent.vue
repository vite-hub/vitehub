<script setup lang="ts">
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <div data-slot="message-content"><slot /></div>
</template>
