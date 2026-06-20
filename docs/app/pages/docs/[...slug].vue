<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { useRoute } from "#app/composables/router";
import { useDocsPage } from "../../composables/useDocsPage";
import { getDocsPageFallback, resolveDocsRoute } from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";

definePageMeta({
  layout: "docs",
});

const route = useRoute();
const routeState = resolveDocsRoute(route.path);
const isBetterAuthFixture = computed(() => route.path.includes("/docs/getting-started/better-auth-style"));

const { data: rawDoc } = await useAsyncData(
  `docs:${routeState.sourcePath}`,
  () => queryCollection("docs").path(routeState.sourcePath).first(),
);

if (!routeState.page || !rawDoc.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { page } = useDocsPage(
  routeState.sourcePath,
  rawDoc,
  getDocsPageFallback(routeState.page),
);

useHead(() => ({
  bodyAttrs: {
    class: isBetterAuthFixture.value ? "better-auth-fixture" : "",
  },
}));

const docsPageUi = computed(() => {
  if (isBetterAuthFixture.value) {
    return {
      root: "better-auth-doc-page lg:!grid-cols-[minmax(0,1fr)] xl:!grid-cols-[minmax(0,796px)_var(--vh-toc-width)] xl:!gap-20",
      center: "lg:!col-span-1 min-w-0",
      right: "hidden xl:block xl:!col-span-1 xl:w-[var(--vh-toc-width)]",
    };
  }

  return {
    root: "lg:!grid-cols-[minmax(0,1fr)] xl:!grid-cols-[minmax(0,1fr)_var(--vh-toc-width)]",
    center: "lg:!col-span-1",
    right: "hidden xl:block xl:!col-span-1 xl:w-[var(--vh-toc-width)]",
  };
});
</script>

<template>
  <UPage v-if="page" :ui="docsPageUi">
    <div v-if="isBetterAuthFixture" class="better-auth-mobile-doc-bar">
      <span class="better-auth-mobile-doc-dot" aria-hidden="true" />
      <span>Install the Package</span>
      <UIcon name="i-lucide-chevron-down" class="ml-auto size-4 text-muted" />
    </div>

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
