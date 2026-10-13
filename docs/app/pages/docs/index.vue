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

// The product catalog has no table of contents. Its rows are the navigation.
const docsPageUi = {
  root: "lg:!grid-cols-1 lg:!gap-0",
  center: "lg:!col-span-1",
  right: "hidden",
};
</script>

<template>
  <UPage v-if="page" :ui="docsPageUi">
    <UPageHeader :title="page.title" :description="page.description">
      <template #links>
        <DocsPageHeaderLinks />
      </template>
    </UPageHeader>

    <UPageBody prose class="docs-content docs-catalog-content pb-0">
      <ContentRenderer :value="page" />
    </UPageBody>
  </UPage>
</template>

<style scoped>
.docs-content :deep(h1:first-of-type) {
  display: none;
}

/* The catalog spans the full page width. ContentRenderer wraps the page in one div. Its intro children keep the measure. */
.docs-catalog-content :deep(> div > :not(.vh-docs-catalog)) {
  max-width: var(--vh-content-width);
}
</style>
