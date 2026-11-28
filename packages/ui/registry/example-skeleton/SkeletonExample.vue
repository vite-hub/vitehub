<script setup lang="ts">
import { Skeleton } from "../skeleton/index.ts";
</script>

<template>
  <div data-slot="example-skeleton" style="display: flex; align-items: center; gap: 0.75rem; max-width: 24rem">
    <Skeleton style="width: 2.5rem; height: 2.5rem; border-radius: 9999px" />
    <div data-slot="example-skeleton-lines" style="display: flex; flex: 1; flex-direction: column; gap: 0.5rem">
      <Skeleton style="height: 0.875rem; width: 60%" />
      <Skeleton style="height: 0.875rem; width: 40%" />
    </div>
  </div>
</template>
