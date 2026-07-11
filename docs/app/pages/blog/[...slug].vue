<script setup lang="ts">
import { computed } from "vue"
import { createError } from "#app/composables/error"
import { useRoute } from "#app/composables/router"

const route = useRoute()
const postPath = computed(() => {
  const parts = route.path.split("/").filter(Boolean)
  return `/blog/${parts.slice(1).join("/")}`
})
const resolvedPostPath = postPath.value

const { data: post } = await useAsyncData(
  `blog:${resolvedPostPath}`,
  () => queryCollection("blog").path(resolvedPostPath).first(),
)

if (!post.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true })
}
const initialPost = post.value

const publishedDate = computed(() => post.value?.date || "")
const formattedDate = computed(() => {
  if (!publishedDate.value) return ""

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(publishedDate.value))
})

useSeoMeta({
  title: initialPost.title,
  ogTitle: `${initialPost.title} · ViteHub`,
  description: initialPost.description,
  ogDescription: initialPost.description,
  ogImage: initialPost.image,
})
</script>

<template>
  <UPage
    v-if="post"
    :ui="{
      root: 'lg:!block',
      center: 'mx-auto w-full max-w-[calc(var(--vh-content-width)+4rem)] lg:!col-span-1',
    }"
  >
    <UPageHeader
      :title="post.title"
      :description="post.description"
      :ui="{
        root: 'border-b-0 px-4 pb-8 sm:px-6 lg:px-8',
        title: 'text-balance text-[34px] leading-[42px] sm:text-[40px] sm:leading-[48px]',
        description: 'max-w-[38rem] text-pretty text-lg leading-8',
      }"
    >
      <template #headline>
        <UButton
          to="/blog"
          variant="link"
          color="neutral"
          icon="i-lucide-arrow-left"
          label="Tutorials"
          class="p-0"
        />
        <span v-if="formattedDate" class="text-muted" aria-hidden="true">·</span>
        <time v-if="formattedDate" :datetime="publishedDate" class="font-normal text-muted">
          {{ formattedDate }}
        </time>
      </template>

      <div v-if="post.authors?.length" class="mt-6 flex flex-wrap items-center gap-5">
        <UUser
          v-for="author in post.authors"
          :key="author.name"
          v-bind="author"
          size="sm"
          :ui="{ name: 'font-medium text-highlighted', description: 'text-muted' }"
        />
      </div>
    </UPageHeader>

    <UPageBody prose class="docs-content blog-content my-0 !max-w-none !px-4 !pb-24 sm:!px-6 lg:!px-8">
      <UContentToc
        v-if="post.body?.toc?.links?.length"
        :links="post.body.toc.links"
        class="mx-0 mb-8 lg:hidden"
      />
      <ContentRenderer :value="post" />
    </UPageBody>
  </UPage>
</template>
