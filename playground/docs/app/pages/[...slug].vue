<script setup lang="ts">
import manifest from "#docs/manifest"

const route = useRoute()
const page = computed(() => [manifest.root, ...manifest.sections.flatMap(section => section.pages), ...manifest.pages].find(item => item?.path === route.path))
</script>

<template>
  <article>
    <h1 class="text-lg font-medium text-highlighted">
      {{ page?.title ?? "Not found" }}
    </h1>
    <p class="text-muted">
      {{ page?.description }}
    </p>
  </article>
</template>
