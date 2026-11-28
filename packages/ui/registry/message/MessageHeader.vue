<script setup lang="ts">
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <div data-slot="message-header"><slot /></div>
</template>
