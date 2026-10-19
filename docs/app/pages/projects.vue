<script setup lang="ts">
// Get started lists this page, so it opens in the docs layout with the sidebar.
definePageMeta({ layout: "docs" });

useSeoMeta({
  title: "Projects",
  ogTitle: "Projects · ViteHub",
  description: "Open source projects built with ViteHub Server Primitives and Agents.",
});
</script>

<template>
  <ExampleCatalog
    kind="project"
    title="Projects"
    description="Open source applications built with ViteHub. Read the source, inspect the package choices, and run the published app when one is available."
  />
</template>
