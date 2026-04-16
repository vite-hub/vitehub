<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { useRoute } from "#app/composables/router";
import { useDocsPage } from "../../../composables/useDocsPage";
import { getDocsPage, getDocsPath, getDocsPathMeta } from "~~/modules/vitehub-docs/runtime/utils/docs";
import type { Framework } from "~~/modules/vitehub-docs/runtime/utils/frameworks";

definePageMeta({
  layout: "docs",
});

const route = useRoute();
const routeMeta = getDocsPathMeta(route.path);

if (!routeMeta) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const docsPage = getDocsPage(routeMeta.section, routeMeta.page);
const sourcePath = getDocsPath(routeMeta.section, routeMeta.framework as Framework, routeMeta.page);
const { data: rawDoc } = await useAsyncData(
  `docs:${sourcePath}`,
  () => queryCollection("docs").path(sourcePath).first(),
);

if (!docsPage || !docsPage.frameworks.includes(routeMeta.framework as Framework) || !rawDoc.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { page } = useDocsPage(
  sourcePath,
  rawDoc,
  { title: docsPage.title, sourceTitle: docsPage.sourceTitle, description: docsPage.description },
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
