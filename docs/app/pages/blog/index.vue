<script setup lang="ts">
import { computed } from "vue"

const { data: posts } = await useAsyncData(
  "blog:tutorials",
  () => queryCollection("blog").all(),
)

const laneOrder: Record<string, number> = {
  "/blog/server-primitives": 0,
  "/blog/agents": 1,
}

const tutorials = computed(() => {
  return [...(posts.value || [])]
    .sort((left, right) => (laneOrder[left.path] ?? 99) - (laneOrder[right.path] ?? 99))
    .map(post => ({
      authors: post.authors,
      badge: post.path === "/blog/server-primitives" ? "Server Primitives" : "Agents",
      date: post.date,
      description: post.description,
      image: post.image,
      title: post.title,
      to: post.path,
    }))
})

useSeoMeta({
  title: "Tutorials",
  ogTitle: "Tutorials · ViteHub",
  description: "Build one working Server Primitive or one working Agent with ViteHub.",
})
</script>

<template>
  <main class="relative min-h-[calc(100vh-var(--ui-header-height,56px))] overflow-hidden">
    <UPageHero
      headline="ViteHub tutorials"
      title="Start where your product starts."
      description="Use a Server Primitive directly, or compose primitives into an Agent. Both paths end with a working, observable result."
      :ui="{
        container: 'relative py-14 sm:py-20 lg:py-24',
        headline: 'font-mono uppercase tracking-[0.18em] text-xs text-primary',
        title: 'mx-auto max-w-3xl text-balance',
        description: 'mx-auto max-w-2xl text-pretty',
      }"
    >
      <template #top>
        <div aria-hidden="true" class="absolute inset-x-0 top-0 -z-10 h-full overflow-hidden">
          <div class="absolute left-1/2 top-8 size-[28rem] -translate-x-1/2 rounded-full bg-primary/8 blur-3xl sm:size-[36rem]" />
          <div class="absolute inset-x-4 top-0 h-full border-x border-default sm:inset-x-6 lg:inset-x-8" />
        </div>
      </template>
    </UPageHero>

    <section class="border-y border-default bg-muted/20">
      <UContainer class="border-x border-default px-4 py-8 sm:px-6 sm:py-10 lg:px-8 lg:py-14">
        <UBlogPosts
          :posts="tutorials"
          orientation="horizontal"
          class="gap-6 sm:grid-cols-2 lg:grid-cols-2 lg:gap-8"
        />

        <div class="mx-auto mt-10 flex max-w-2xl flex-col items-center gap-2 text-center text-sm text-muted sm:flex-row sm:justify-center sm:gap-3">
          <span>Server Primitives work on their own.</span>
          <UIcon name="i-lucide-arrow-right" class="hidden size-4 shrink-0 sm:block" />
          <span>Agents compose them when they need more reach.</span>
        </div>
      </UContainer>
    </section>

    <UContainer class="relative min-h-24 grow">
      <div aria-hidden="true" class="absolute inset-y-0 -z-10 border-x border-default inset-x-4 sm:inset-x-6 lg:inset-x-8" />
    </UContainer>
  </main>
</template>
