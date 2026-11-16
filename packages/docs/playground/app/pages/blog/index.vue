<script setup lang="ts">
// Published posts of the `blog` collection, newest first.
const { data: posts } = await useFetch("/api/blog", { key: "blog" })

useSeoMeta({ title: "Blog", description: "Releases, engineering notes, and guides from the Lumen team." })
useHead({ link: [{ rel: "alternate", type: "application/rss+xml", title: "Lumen blog", href: "/blog/rss.xml" }] })
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 pb-24 pt-14 sm:px-6 sm:pt-20 lg:px-8">
    <header class="flex items-end justify-between gap-6 border-b border-default pb-8">
      <div>
        <h1 class="text-balance text-[38px] font-semibold leading-[46px] tracking-[-0.03em] text-highlighted">Blog</h1>
        <p class="mt-3 text-pretty text-lg leading-8 text-muted">Releases, engineering notes, and guides from the Lumen team.</p>
      </div>
      <UButton to="/blog/rss.xml" external target="_blank" icon="i-lucide-rss" label="RSS" color="neutral" variant="outline" size="sm" />
    </header>

    <ol v-if="posts?.length">
      <li v-for="post in posts" :key="post.id" class="border-b border-default">
        <NuxtLink :to="post.url" class="group grid gap-2 py-7 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-8">
          <time :datetime="post.date" class="pt-0.5 text-sm text-muted">{{ formatDate(post.date) }}</time>
          <div>
            <h2 class="text-balance text-xl font-semibold leading-7 tracking-[-0.01em] text-highlighted group-hover:underline group-hover:underline-offset-4">{{ post.title }}</h2>
            <p class="mt-2 text-pretty leading-7 text-muted">{{ post.description }}</p>
            <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
              <span class="inline-flex items-center gap-2">
                <UAvatarGroup size="2xs">
                  <UAvatar v-for="author in post.authors" :key="author.id" :alt="author.name" />
                </UAvatarGroup>
                {{ post.authors.map(author => author.name).join(", ") }}
              </span>
              <span v-for="tag in post.tags" :key="tag" class="font-mono text-xs">#{{ tag }}</span>
            </div>
          </div>
        </NuxtLink>
      </li>
    </ol>

    <div v-else class="flex flex-col items-center py-16 text-center">
      <LumenIllustration name="edit-this-site" alt="A monitor with the Console editor, two databases, and a media crate." class="w-full max-w-xs" />
      <h2 class="mt-6 font-semibold text-highlighted">No posts yet</h2>
      <p class="mt-2 max-w-sm text-pretty text-sm leading-6 text-muted">Editors write posts in the Console. A published post shows here on the next visit.</p>
      <UButton to="/docs/this-site/edit-and-publish" class="mt-5" color="neutral" variant="outline" size="sm" label="How to publish" />
    </div>
  </div>
</template>
