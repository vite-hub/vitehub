<script setup lang="ts">
import { contentField } from "vite-hub/content/client"

// One published post. In the Console preview it is the draft on screen.
const route = useRoute()
const id = String(route.params.id)
const { data: post } = await useFetch(`/api/blog/${encodeURIComponent(id)}`, { key: `blog:${id}` })
if (!post.value) throw createError({ statusCode: 404, statusMessage: "Post not found", fatal: true })

// `contentField()` marks the elements that render a field, so Comments and the Console find the document behind them.
const field = (name: string) => contentField("blog", id, name)

useSeoMeta({ title: post.value.title, ogTitle: post.value.title, description: post.value.description, ogDescription: post.value.description, ogType: "article" })
</script>

<template>
  <article v-if="post" class="mx-auto w-full max-w-3xl px-4 pb-24 pt-10 sm:px-6 sm:pt-14 lg:px-8">
    <NuxtLink to="/blog" class="inline-flex items-center gap-1.5 text-sm text-muted hover:text-highlighted">
      <UIcon name="i-lucide-arrow-left" class="size-3.5" aria-hidden="true" />
      Blog
    </NuxtLink>

    <header class="mt-8 border-b border-default pb-8">
      <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <time :datetime="post.date">{{ formatDate(post.date) }}</time>
        <span v-for="tag in post.tags" :key="tag" class="font-mono text-xs">#{{ tag }}</span>
      </p>
      <h1 class="mt-3 text-balance text-[34px] font-semibold leading-[42px] tracking-[-0.03em] text-highlighted sm:text-[42px] sm:leading-[50px]" v-bind="field('title')">
        {{ post.title }}
      </h1>
      <p class="mt-4 text-pretty text-lg leading-8 text-muted" v-bind="field('description')">{{ post.description }}</p>
      <ul class="mt-6 flex flex-wrap gap-x-6 gap-y-3" v-bind="field('authors')">
        <li v-for="author in post.authors" :key="author.id" class="flex items-center gap-2.5">
          <UAvatar :alt="author.name" size="sm" />
          <span class="text-sm leading-5">
            <a v-if="author.github" :href="`https://github.com/${author.github}`" class="font-medium text-highlighted hover:underline">{{ author.name }}</a>
            <span v-else class="font-medium text-highlighted">{{ author.name }}</span>
            <span class="block text-muted">{{ author.role }}</span>
          </span>
        </li>
      </ul>
    </header>

    <figure v-if="post.cover" class="mt-8 border border-default" v-bind="field('cover')">
      <LumenIllustration :light="post.cover.light" :dark="post.cover.dark" :alt="`Illustration for ${post.title}`" eager class="mx-auto max-w-lg" />
    </figure>

    <UPageBody prose class="docs-content !px-0 !pb-0 pt-8" v-bind="field('body')">
      <DocsMarkdown :document="post.document" :components="{ pre: resolveComponent('DocsCodePre') }" />
    </UPageBody>
  </article>
</template>
