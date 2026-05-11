<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { useRoute } from "#app/composables/router";
import { computed, provide, ref } from "vue";
import { useDocsPage } from "../../../composables/useDocsPage";
import { getDocsPageFallback, resolveDocsRoute } from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";

definePageMeta({
  layout: "docs-blog",
});

const route = useRoute();
const docsPath = computed(() => {
  const parts = route.path.split("/").filter(Boolean);
  const framework = parts[1];
  const slug = parts.slice(2);
  const docsSlug = slug[0] === "tutorials" ? slug : ["tutorials", ...slug];

  return `/docs/${framework}/${docsSlug.join("/")}`;
});
const routeState = resolveDocsRoute(docsPath.value);

if (!routeState) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { data: rawDoc } = await useAsyncData(
  `blogs:${routeState.sourcePath}`,
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

const tree = ref<Record<string, unknown>>({});
const activePath = ref<string>("");
provide("codeTree", tree);
provide("codeTreeActive", activePath);

const treeItems = computed(() => Object.entries(tree.value).map(([label, component]) => ({ label, component })));
const appConfig = useAppConfig();
</script>

<template>
  <div v-if="page">
    <div class="px-4 sm:px-6 lg:px-8 max-w-(--ui-container) mx-auto">
      <UPageHeader :title="page.title" :description="page.description" />
    </div>
    <UPage :ui="{ center: 'lg:col-span-5 px-4 sm:px-6 lg:pl-8 lg:pr-0', right: 'lg:col-span-5' }" class="lg:gap-8">
      <UPageBody prose class="docs-content blogs-content pb-24">
        <ContentRenderer :value="page" />
      </UPageBody>

      <template #right>
        <div>
          <UContentToc :links="page.body?.toc?.links || []" class="z-2 lg:hidden mx-0!" />
          <nav class="hidden lg:block h-full sticky top-(--ui-header-height) max-h-[calc(100vh-var(--ui-header-height))]">
            <ProseCodeTree
              v-if="activePath"
              :model-value="activePath"
              :items="treeItems"
              expand-all
              class="lg:h-full my-0 rounded-none border-y-0 border-r-0 border-default"
              :ui="{ list: 'border-default', content: '[&>div>pre]:bg-muted/50 [&>div>pre]:border-default [&>div>pre]:rounded-none' }"
            />
            <div v-else class="size-full border-l border-default flex items-center justify-center">
              <UIcon :name="appConfig.ui.icons.arrowDown" class="size-12 text-dimmed animate-bounce" />
            </div>
          </nav>
        </div>
      </template>
    </UPage>
  </div>
</template>

<style scoped>
.docs-content :deep(h1:first-of-type) {
  display: none;
}

.blogs-content :deep(> p:first-of-type) {
  max-width: 44rem;
  margin-top: 0;
  color: var(--ui-text-muted);
}
</style>
