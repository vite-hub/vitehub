<script setup lang="ts">
import { computed, provide, ref } from "vue";
import { createError } from "#app/composables/error";
import { useRoute } from "#app/composables/router";

const route = useRoute();
const postPath = computed(() => {
  const parts = route.path.split("/").filter(Boolean);
  return `/blog/${parts.slice(1).join("/")}`;
});
const resolvedPostPath = postPath.value;

const { data: post } = await useAsyncData(
  `blog:${resolvedPostPath}`,
  () => queryCollection("blog").path(resolvedPostPath).first(),
);

if (!post.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}
const initialPost = post.value;

const tree = ref<Record<string, unknown>>({});
const activePath = ref("");
provide("codeTree", tree);
provide("codeTreeActive", activePath);

const treeItems = computed(() => Object.entries(tree.value).map(([label, component]) => ({ label, component })));
const isTutorialLayout = computed(() => post.value?.layout === "tutorial");

const publishedDate = computed(() => post.value?.date || "");
const formattedDate = computed(() => {
  if (!publishedDate.value) return "";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(publishedDate.value));
});

useSeoMeta({
  title: initialPost.title,
  ogTitle: `${initialPost.title} · ViteHub`,
  description: initialPost.description,
  ogDescription: initialPost.description,
  ogImage: initialPost.image,
});
</script>

<template>
  <main
    v-if="post"
    :class="isTutorialLayout
      ? 'mx-auto grid w-full max-w-[112rem] grid-cols-1 gap-8 px-4 pb-24 pt-8 sm:px-6 lg:grid-cols-[minmax(0,42rem)_minmax(0,1fr)] lg:gap-8 lg:px-8 lg:pr-0 xl:grid-cols-[minmax(0,44rem)_minmax(0,1fr)] xl:px-12 xl:pr-0'
      : 'mx-auto w-full max-w-[var(--vh-content-width)] px-4 pb-24 pt-8 sm:px-6 lg:px-8'"
  >
    <article class="min-w-0">
      <header class="pb-8">
        <div class="flex flex-wrap items-center gap-2 text-sm text-muted">
          <UButton
            to="/blog"
            variant="link"
            color="neutral"
            icon="i-lucide-arrow-left"
            label="Blog"
            class="p-0"
          />
          <span v-if="formattedDate" aria-hidden="true">·</span>
          <time v-if="formattedDate" :datetime="publishedDate">{{ formattedDate }}</time>
        </div>

        <h1 class="mt-5 text-[34px] font-semibold leading-[42px] text-highlighted sm:text-[40px] sm:leading-[48px]">
          {{ post.title }}
        </h1>
        <p class="mt-4 max-w-[38rem] text-lg leading-8 text-muted">
          {{ post.description }}
        </p>

        <div v-if="post.authors?.length" class="mt-5 flex flex-wrap items-center gap-4">
          <UUser
            v-for="author in post.authors"
            :key="author.name"
            v-bind="author"
            size="sm"
            :ui="{ name: 'font-medium text-highlighted', description: 'text-muted' }"
          />
        </div>
      </header>

      <UPageBody prose class="docs-content blog-content !px-0 !pb-0 sm:!px-0 lg:!px-0 xl:!px-0">
        <ContentRenderer :value="post" />
      </UPageBody>
    </article>

    <aside
      v-if="isTutorialLayout"
      class="hidden min-w-0 border-l border-default lg:block"
    >
      <div class="sticky top-[var(--ui-header-height,56px)] h-[calc(100vh-var(--ui-header-height,56px))] overflow-hidden">
        <ProseCodeTree
          v-if="activePath"
          :model-value="activePath"
          :items="treeItems"
          expand-all
          class="my-0 h-full min-h-0 w-full rounded-none border-0 lg:!h-full lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)]"
          :ui="{
            root: 'my-0 h-full min-h-0 w-full rounded-none border-0',
            list: 'h-full min-h-0 border-default p-1 pr-2',
            listWithChildren: 'ms-3 border-s border-default',
            itemWithChildren: 'ps-1 -ms-px',
            link: 'px-1.5 py-1.5 gap-1.5',
            content: 'h-full min-w-0 lg:!col-span-1 lg:!col-start-2 lg:!row-start-1 [&>div]:m-0 [&>div]:h-full [&>div]:min-h-0 [&>div]:w-full [&>div]:!overflow-hidden [&>div>pre]:min-h-0 [&>div>pre]:w-full [&>div>pre]:max-w-none [&>div>pre]:flex-1 [&>div>pre]:overflow-auto [&>div>pre]:bg-muted/50 [&>div>pre]:border-default [&>div>pre]:rounded-none [&>div>pre]:px-3 [&>div>pre]:py-3',
          }"
        />

        <div v-else class="grid h-full min-h-0 place-items-center text-muted">
          <UIcon name="i-lucide-arrow-down" class="size-10 animate-bounce" />
        </div>
      </div>
    </aside>
  </main>
</template>

<style scoped>
.blog-content :deep(h1:first-of-type) {
  display: none;
}

.blog-content :deep(> p:first-of-type) {
  margin-top: 0;
  color: var(--ui-text-muted);
}

.blog-content :deep(.setup-collapsible) {
  margin-block: 1.5rem;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: color-mix(in srgb, var(--ui-bg-muted) 38%, transparent);
}

.blog-content :deep(.setup-collapsible > button) {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  padding: 0.875rem 1rem;
  color: var(--ui-text);
  font-size: 1rem;
  font-weight: 500;
  line-height: 1.75rem;
  text-align: left;
}

.blog-content :deep(.setup-collapsible > button:hover) {
  background: color-mix(in srgb, var(--ui-bg-muted) 68%, transparent);
}

.blog-content :deep(.setup-collapsible > button:focus-visible) {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.blog-content :deep(.setup-collapsible > button svg) {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  color: var(--ui-text-muted);
}

.blog-content :deep(.setup-collapsible > button span:last-child) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.blog-content :deep(.setup-collapsible [data-slot="content"]) {
  border-top: 1px solid var(--ui-border);
  padding: 1rem;
  color: var(--ui-text);
  font-size: 1rem;
  line-height: 1.75rem;
}

.blog-content :deep(.setup-collapsible [data-slot="content"] > *:first-child) {
  margin-top: 0;
}

.blog-content :deep(.setup-collapsible [data-slot="content"] > *:last-child) {
  margin-bottom: 0;
}

@media (min-width: 640px) {
  .blog-content :deep(.setup-collapsible > button),
  .blog-content :deep(.setup-collapsible [data-slot="content"]) {
    font-size: 0.875rem;
    line-height: 1.5rem;
  }

  .blog-content :deep(.setup-collapsible > button) {
    padding-block: 0.75rem;
  }
}
</style>
