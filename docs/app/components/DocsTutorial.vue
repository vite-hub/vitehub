<script setup lang="ts">
import type { ContentPage } from "../composables/useDocsPage";

defineProps<{ page: ContentPage }>();
</script>

<template>
  <DocsArticle :page="page" tutorial />
</template>
