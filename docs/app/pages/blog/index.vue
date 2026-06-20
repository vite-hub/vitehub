<script setup lang="ts">
import { computed } from "vue";

const { data: posts } = await useAsyncData(
  "blog:entries",
  () => queryCollection("blog").all(),
);

const entries = computed(() => {
  return [...(posts.value || [])].sort((left, right) => {
    const leftTime = left.date ? new Date(left.date).getTime() : 0;
    const rightTime = right.date ? new Date(right.date).getTime() : 0;

    return rightTime - leftTime;
  });
});

useSeoMeta({
  title: "Blog",
  ogTitle: "Blog · ViteHub",
  description: "Guides and implementation notes for building with ViteHub server primitives and agents.",
});

function formatDate(value?: string) {
  if (!value) return "";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}
</script>

<template>
  <main class="mx-auto w-full max-w-6xl px-4 pb-24 pt-16 sm:px-6 lg:px-8">
    <header class="max-w-2xl border-b border-default pb-10">
      <h1 class="text-[40px] font-semibold leading-[48px] text-highlighted">
        Blog
      </h1>
      <p class="mt-6 text-xl leading-8 text-muted">
        Guides and notes for composing ViteHub primitives, workspaces, and agents in real applications.
      </p>
    </header>

    <div class="mt-10 grid gap-7 md:grid-cols-2 xl:grid-cols-3">
      <ULink
        v-for="post in entries"
        :key="post.path"
        :to="post.path"
        class="group flex min-w-0 flex-col border-t border-default pt-6"
      >
        <div class="overflow-hidden rounded-sm border border-default bg-muted">
          <img
            v-if="post.image"
            :src="post.image"
            :alt="post.title"
            class="aspect-[16/10] w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          >
          <div v-else class="grid aspect-[16/10] place-items-center">
            <UIcon :name="post.icon || 'i-lucide-newspaper'" class="size-8 text-muted" />
          </div>
        </div>

        <article class="flex min-w-0 flex-1 flex-col pt-5">
          <div class="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
            <UBadge v-if="post.category" color="neutral" variant="soft">
              {{ post.category }}
            </UBadge>
            <time v-if="post.date" :datetime="post.date">{{ formatDate(post.date) }}</time>
          </div>
          <h2 class="text-2xl font-semibold tracking-normal text-highlighted group-hover:text-primary">
            {{ post.title }}
          </h2>
          <p class="mt-3 text-base leading-7 text-muted">
            {{ post.description }}
          </p>
          <div v-if="post.authors?.length" class="mt-5 flex flex-wrap items-center gap-4">
            <UUser
              v-for="author in post.authors"
              :key="author.name"
              :name="author.name"
              :description="author.description"
              :avatar="author.avatar"
              size="xs"
              :ui="{ name: 'font-medium text-highlighted', description: 'text-muted' }"
            />
          </div>
        </article>
      </ULink>
    </div>
  </main>
</template>
