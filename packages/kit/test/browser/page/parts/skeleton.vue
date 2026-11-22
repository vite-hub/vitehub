<script setup lang="ts">
</script>

<template>
  <div data-slot="stack" aria-busy="true" aria-label="Loading sessions">
    <div data-slot="row">
      <div data-slot="vh-skeleton" aria-hidden="true" style="width: 1.75rem; height: 1.75rem; border-radius: 9999px" />
      <div data-slot="vh-skeleton" aria-hidden="true" style="width: 6rem; height: 0.875rem" />
    </div>
    <div data-slot="vh-skeleton" aria-hidden="true" style="height: 2.25rem" />
    <div data-slot="vh-skeleton" aria-hidden="true" style="width: 66%; height: 1rem; animation: none" />
    <div data-slot="vh-skeleton" aria-hidden="true" style="height: 0.25rem; border-radius: 9999px" />
  </div>
</template>
