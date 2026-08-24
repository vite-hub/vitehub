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

const contentTocVariants = useUIConfig("contentToc");
const isReferencePage = computed(() => route.path.replace(/\/+$/, "") === "/docs/reference");
const isSupportMatrix = computed(
  () => route.path.replace(/\/+$/, "") === "/docs/frameworks-hosts/support-matrix",
);
const tocLinks = computed(() => page.value?.body?.toc?.links || []);

const docsPageUi = {
  root: "lg:!grid-cols-[minmax(0,1fr)_var(--vh-toc-width)] lg:!gap-12",
  center: "lg:!col-span-1",
  right: "hidden lg:block lg:!col-span-1 lg:w-[var(--vh-toc-width)]",
};

const mobileTocUi = {
  root: "!top-[var(--ui-header-height)] !z-20 !mx-0 !max-h-[calc(100dvh-var(--ui-header-height))] !bg-default !px-4 sm:!px-8 lg:!hidden",
  container: "!border-s-0 !border-b !border-default !ps-0 !pt-2 !pb-2",
  trigger: "!py-2 text-sm font-medium text-muted hover:text-highlighted",
  title: "text-sm font-medium",
  content: "!pb-2",
};
</script>

<template>
  <SupportMatrix v-if="page && isSupportMatrix" />

  <UPage v-else-if="page" :ui="docsPageUi">
    <UContentToc
      v-if="tocLinks.length"
      class="lg:hidden"
      :highlight="contentTocVariants.highlight ?? true"
      :highlight-color="contentTocVariants.highlightColor"
      :highlight-variant="contentTocVariants.highlightVariant"
      :color="contentTocVariants.color"
      title="On this page"
      :links="tocLinks"
      :ui="mobileTocUi"
    />

    <UPageHeader :title="page.title" :description="page.description">
      <template #links>
        <DocsPageHeaderLinks />
      </template>
    </UPageHeader>

    <UPageBody prose :class="['docs-content pb-0', { 'docs-reference-content': isReferencePage }]">
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
