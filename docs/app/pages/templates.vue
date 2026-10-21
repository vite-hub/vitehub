<script setup lang="ts">
// Get started lists this page, so it opens in the docs layout with the sidebar.
definePageMeta({ layout: "docs" });

useSeoMeta({
  title: "Templates",
  ogTitle: "Templates · ViteHub",
  description: "Start a ViteHub application from a published GitHub template.",
});
</script>

<template>
  <ExampleCatalog
    kind="template"
    title="Templates"
    description="Start from a working ViteHub application. Each template links to its source and shows the first file to open."
  />
</template>
