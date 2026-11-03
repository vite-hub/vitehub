<script setup lang="ts">
// Get started lists this page, so it opens in the docs layout with the sidebar.
definePageMeta({ layout: "docs" });

useSeoMeta({
  title: "Tutorials",
  ogTitle: "Tutorials",
  description: "Build complete applications with Nuxt and ViteHub, or start with a short product quickstart.",
});
</script>

<template>
  <main>
    <UContainer class="mx-auto w-full !max-w-7xl !px-4 py-10 sm:!px-6 sm:py-14 lg:!px-8">
      <UPageHeader
        title="Tutorials"
        description="Build an app you can run and extend. Follow a complete project, or start with one feature in a short quickstart."
        :ui="{ root: 'border-0 px-0 pt-0 pb-8 sm:px-0 lg:px-0 xl:px-0', description: 'max-w-2xl', title: 'text-3xl sm:text-4xl' }"
      />
      <TutorialCatalog />
    </UContainer>
  </main>
</template>
