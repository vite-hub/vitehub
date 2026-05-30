<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { useDocsPage } from "../../composables/useDocsPage";
import { getDocsPageByPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsPageFallback } from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";

definePageMeta({
  layout: "docs",
});

const docsPage = getDocsPageByPath("/docs");
const { data: rawDoc } = await useAsyncData(
  "docs:index",
  () => queryCollection("docs").path("/docs").first(),
);

if (!docsPage) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { page } = useDocsPage(
  "/docs",
  rawDoc,
  getDocsPageFallback(docsPage),
);
</script>

<template>
  <UPage v-if="page">
    <UPageHeader :title="page.title" :description="page.description">
      <template #links>
        <DocsPageHeaderLinks />
      </template>
    </UPageHeader>

    <UPageBody prose class="docs-content pb-0">
      <ContentRenderer :value="page" />
    </UPageBody>

    <template #right>
      <DocsAsideRight :page="page" />
    </template>
  </UPage>
</template>

<style scoped>
.docs-content :deep(h1:first-of-type) {
  display: none;
}
</style>
