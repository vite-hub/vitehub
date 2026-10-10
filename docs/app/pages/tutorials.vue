<script setup lang="ts">
useSeoMeta({
  title: "Tutorials",
  ogTitle: "Tutorials · ViteHub",
  description: "Build a working ViteHub feature with a step-by-step tutorial for each package.",
});
</script>

<template>
  <main>
    <UContainer class="mx-auto w-full !max-w-7xl !px-4 py-10 sm:!px-6 sm:py-14 lg:!px-8">
      <UPageHeader
        title="Tutorials"
        description="Build a working feature, one step at a time. Each tutorial includes the files to create and a result you can check."
        :ui="{ root: 'border-0 pt-0 pb-8', description: 'max-w-2xl', title: 'text-3xl sm:text-4xl' }"
      />
      <TutorialCatalog />
    </UContainer>
  </main>
</template>
