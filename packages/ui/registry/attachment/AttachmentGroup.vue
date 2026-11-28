<script setup lang="ts">
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <div data-slot="attachment-group"><slot /></div>
</template>
