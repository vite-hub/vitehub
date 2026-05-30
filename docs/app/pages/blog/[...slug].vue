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
  <UContainer v-if="post">
    <UPage :ui="{ center: 'max-w-[var(--vh-content-width,860px)]', right: 'hidden xl:block w-[26rem] shrink-0' }">
      <UPageHeader :title="post.title" :description="post.description">
        <template #headline>
          <div class="flex flex-wrap items-center gap-2 text-sm text-muted">
            <UButton
              to="/blog"
              variant="link"
              color="neutral"
              icon="i-lucide-arrow-left"
              label="Blog entries"
              class="p-0"
            />
            <span v-if="formattedDate" aria-hidden="true">·</span>
            <time v-if="formattedDate" :datetime="publishedDate">{{ formattedDate }}</time>
          </div>
        </template>
      </UPageHeader>

      <UPageBody prose class="docs-content blog-content pb-24">
        <img
          v-if="post.image"
          :src="post.image"
          :alt="post.title"
          class="not-prose mb-10 aspect-[16/8] w-full rounded-sm border border-default object-cover"
        >
        <ContentRenderer :value="post" />
      </UPageBody>

      <template #right>
        <aside class="sticky top-[calc(var(--ui-header-height,56px)+1.5rem)] max-h-[calc(100vh-var(--ui-header-height,56px)-3rem)] overflow-hidden">
          <ProseCodeTree
            v-if="activePath"
            :model-value="activePath"
            :items="treeItems"
            expand-all
            class="my-0 h-full min-h-[32rem] rounded-sm border border-default"
            :ui="{ list: 'border-default', content: '[&>div>pre]:bg-muted/50 [&>div>pre]:border-default [&>div>pre]:rounded-none' }"
          />

          <div v-else class="border border-default p-4">
            <DocsAsideRight :page="post" />
          </div>
        </aside>
      </template>
    </UPage>
  </UContainer>
</template>

<style scoped>
.blog-content :deep(h1:first-of-type) {
  display: none;
}

.blog-content :deep(> p:first-of-type) {
  margin-top: 0;
  color: var(--ui-text-muted);
}
</style>
