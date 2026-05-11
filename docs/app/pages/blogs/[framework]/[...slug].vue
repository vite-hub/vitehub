<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { useRoute } from "#app/composables/router";
import { computed, provide, ref } from "vue";
import { useDocsPage } from "../../../composables/useDocsPage";
import { useFrameworkPreference } from "../../../composables/useFrameworkPreference";
import { getDocsPageFallback, resolveDocsRoute } from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";
import { frameworkColorIcons, frameworkLabels, type Framework, visibleFrameworks } from "~~/modules/vitehub-docs/runtime/utils/frameworks";

type BlogAuthor = {
  avatar?: string;
  name: string;
};

type BlogPageMeta = {
  authors?: BlogAuthor[];
  date?: string;
  image?: string;
};

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
const { current: framework, switchTo } = useFrameworkPreference();
const blogMeta = computed(() => rawDoc.value as unknown as BlogPageMeta | null);
const publishedDate = computed(() => blogMeta.value?.date || "");
const heroImage = computed(() => blogMeta.value?.image || "");

const formattedDate = computed(() => {
  if (!publishedDate.value) {
    return "";
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(publishedDate.value));
});

const authors = computed(() => {
  const value = blogMeta.value?.authors;
  return Array.isArray(value) ? value : [];
});

const backToBlogPath = computed(() => `/blogs/${routeState.meta.framework}`);

const frameworkOptions = computed(() => visibleFrameworks.map(fw => ({
  id: fw,
  label: frameworkLabels[fw],
  icon: frameworkColorIcons[fw],
})));

function selectFramework(fw: Framework) {
  switchTo(fw);
}
</script>

<template>
  <div v-if="page">
    <div class="px-4 sm:px-6 lg:px-8 max-w-(--ui-container) mx-auto">
      <header class="py-8 sm:py-10">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap items-center gap-2 text-sm text-muted">
            <UButton
              :to="backToBlogPath"
              variant="link"
              color="neutral"
              icon="i-lucide-arrow-left"
              label="Back to blog"
              class="p-0"
            />
            <span v-if="formattedDate" aria-hidden="true">·</span>
            <time v-if="formattedDate" :datetime="publishedDate">{{ formattedDate }}</time>
          </div>

          <div
            class="inline-flex w-fit rounded-lg border border-default bg-muted/30 p-1"
            aria-label="Choose framework"
            role="radiogroup"
          >
            <button
              v-for="option in frameworkOptions"
              :key="option.id"
              type="button"
              role="radio"
              :aria-checked="framework === option.id"
              class="inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors"
              :class="framework === option.id ? 'bg-default text-highlighted shadow-xs' : 'text-muted hover:text-highlighted'"
              @click="selectFramework(option.id)"
            >
              <UIcon :name="option.icon" class="size-4 shrink-0" />
              <span>{{ option.label }}</span>
            </button>
          </div>
        </div>

        <div class="mt-6 max-w-4xl">
          <h1 class="text-4xl font-bold tracking-tight text-highlighted text-pretty sm:text-5xl">
            {{ page.title }}
          </h1>
          <p class="mt-5 text-lg leading-8 text-muted text-pretty">
            {{ page.description }}
          </p>
        </div>

        <div v-if="authors.length" class="mt-6 flex flex-wrap items-center gap-4">
          <div
            v-for="author in authors"
            :key="author.name"
            class="flex items-center gap-3"
          >
            <UAvatar :src="author.avatar" :alt="author.name" size="md" />
            <span class="font-medium text-highlighted">{{ author.name }}</span>
          </div>
        </div>

        <img
          v-if="heroImage"
          :src="heroImage"
          :alt="page.title"
          class="mt-8 aspect-[16/9] w-full rounded-lg border border-default object-cover shadow-sm"
        />
      </header>
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
              <UIcon name="i-lucide-arrow-down" class="size-12 text-dimmed animate-bounce" />
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
