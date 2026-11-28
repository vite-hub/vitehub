<script setup lang="ts">
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <span data-slot="attachment-title"><slot /></span>
</template>
