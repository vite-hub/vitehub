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
  avatar?: {
    src: string;
  };
  name: string;
  to?: string;
};

type BlogPageMeta = {
  authors?: BlogAuthor[];
  codeRail?: boolean;
  date?: string;
  image?: string;
  meta?: {
    codeRail?: boolean;
  };
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
  route.path,
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
const usesCodeRail = computed(() => blogMeta.value?.codeRail !== false && blogMeta.value?.meta?.codeRail !== false);
const publishedDate = computed(() => blogMeta.value?.date || "");
const pageUi = computed(() => usesCodeRail.value
  ? {
      center: "lg:col-span-5 px-4 sm:px-6 lg:pl-8 lg:pr-0",
      right: "lg:col-span-5",
    }
  : {
      center: "mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8",
    });
const pageClass = computed(() => usesCodeRail.value ? "lg:gap-8" : "");

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
  <UPage v-if="page" :ui="pageUi" :class="pageClass">
    <UPageHeader :title="page.title" :description="page.description" :ui="{ title: 'relative flex items-center' }">
      <template #headline>
        <div class="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
      </template>

      <div v-if="authors.length" class="flex items-center gap-6 mt-6">
        <template v-for="author in authors" :key="author.name">
          <ULink v-if="author.to" :to="author.to" target="_blank" class="flex items-center gap-3 group">
            <UAvatar :src="author.avatar?.src" :alt="author.name" size="lg" />
            <div class="flex flex-col">
              <span class="text-sm font-medium text-highlighted">{{ author.name }}</span>
              <span class="text-xs text-muted group-hover:text-primary transition-colors">@{{ author.to.split("/").pop() }}</span>
            </div>
          </ULink>
          <div v-else class="flex items-center gap-3">
            <UAvatar :src="author.avatar?.src" :alt="author.name" size="lg" />
            <span class="text-sm font-medium text-highlighted">{{ author.name }}</span>
          </div>
        </template>
      </div>
    </UPageHeader>

    <UPageBody prose class="docs-content blogs-content pb-24">
      <ContentRenderer :value="page" />
    </UPageBody>

    <template v-if="usesCodeRail" #right>
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
