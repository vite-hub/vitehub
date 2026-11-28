<script setup lang="ts">
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <div data-slot="attachment-actions"><slot /></div>
</template>
