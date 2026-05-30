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
  <UContainer>
    <UPage :ui="{ center: 'max-w-5xl mx-auto' }">
      <UPageHeader
        title="Blog"
        description="Guides and notes for composing ViteHub primitives, workspaces, and agents in real applications."
      />

      <UPageBody class="pb-24">
        <div class="grid gap-4">
          <ULink
            v-for="post in entries"
            :key="post.path"
            :to="post.path"
            class="group grid gap-5 border-t border-default py-6 sm:grid-cols-[14rem_minmax(0,1fr)]"
          >
            <div class="overflow-hidden rounded-sm border border-default bg-muted">
              <img
                v-if="post.image"
                :src="post.image"
                :alt="post.title"
                class="aspect-[16/10] h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
              >
              <div v-else class="aspect-[16/10] grid place-items-center">
                <UIcon :name="post.icon || 'i-lucide-newspaper'" class="size-8 text-muted" />
              </div>
            </div>

            <article class="min-w-0">
              <div class="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
                <UBadge v-if="post.category" color="neutral" variant="soft">
                  {{ post.category }}
                </UBadge>
                <time v-if="post.date" :datetime="post.date">{{ formatDate(post.date) }}</time>
              </div>
              <h2 class="text-2xl font-semibold tracking-normal text-highlighted group-hover:text-primary">
                {{ post.title }}
              </h2>
              <p class="mt-3 max-w-2xl text-base leading-7 text-muted">
                {{ post.description }}
              </p>
            </article>
          </ULink>
        </div>
      </UPageBody>
    </UPage>
  </UContainer>
</template>
