<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { useRoute } from "#app/composables/router";
import { useDocsPage } from "../../../../composables/useDocsPage";
import { getDocsPageFallback, resolveDocsRoute } from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";

definePageMeta({
  layout: "docs-blog",
});

const route = useRoute();
const routeState = resolveDocsRoute(route.path);

if (!routeState) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { data: rawDoc } = await useAsyncData(
  `docs:${routeState.sourcePath}`,
  () => queryCollection("docs").path(routeState.sourcePath).first(),
);

if (!routeState.page || !routeState.supported || !rawDoc.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { page } = useDocsPage(
  routeState.sourcePath,
  rawDoc,
  getDocsPageFallback(routeState.page),
);
</script>

<template>
  <UPage v-if="page" :ui="{ center: 'mx-auto max-w-5xl' }">
    <UPageHeader :title="page.title" :description="page.description" />

    <UPageBody prose class="docs-content tutorials-index-content pb-24">
      <ContentRenderer :value="page" />
    </UPageBody>
  </UPage>
</template>

<style scoped>
.docs-content :deep(h1:first-of-type) {
  display: none;
}

.tutorials-index-content :deep(> p:first-of-type) {
  max-width: 44rem;
  margin-top: 0;
  color: var(--ui-text-muted);
}
</style>
