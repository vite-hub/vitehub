<script setup lang="ts">
import { useUserSession } from "vite-hub/auth/vue"

import type { DocsPageResponse } from "@vite-hub/docs"

// The landing page. Its title, description, and body are content/index.md, so editors change them in the Console like
// any page. The hero, the latest release, and the latest posts are this page's own.
const { data } = await useFetch<DocsPageResponse>("/api/_docs/page/index.json", { key: "docs:/" })
if (!data.value) throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true })
const page = computed(() => data.value!.page)

// The build prerenders this page, and the CMS is not there at build time. The browser reads the latest release and
// posts after the page loads.
const { data: releases } = useFetch("/api/changelog", { query: { limit: 1 }, server: false, key: "landing:release" })
const { data: posts } = useFetch("/api/blog", { query: { limit: 3 }, server: false, key: "landing:posts" })
const latest = computed(() => releases.value?.[0])

// A signed-in editor goes to the Console; everyone else reads how this site is edited.
const { loggedIn } = useUserSession()

const install = "pnpm add -g lumen-cli"
const copied = ref(false)
async function copyInstall() {
  await navigator.clipboard.writeText(install)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

const hero = illustrationUrls("hero")
useHead({ link: [{ rel: "preload", as: "image", href: hero.light, fetchpriority: "high" }, { rel: "preload", as: "image", href: hero.dark }] })
useSeoMeta({ title: page.value.sourceTitle, ogTitle: page.value.sourceTitle, description: page.value.description, ogDescription: page.value.description })
</script>

<template>
  <div class="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6 lg:px-8" :data-path="page.path">
    <section class="grid items-center gap-10 border-b border-default pb-14 pt-12 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12 lg:pb-20 lg:pt-20">
      <div class="min-w-0">
        <NuxtLink
          to="/changelog"
          class="inline-flex h-7 items-center gap-2 border border-default px-2.5 text-xs text-muted transition-colors hover:text-highlighted"
        >
          <span class="font-mono text-highlighted">{{ latest ? `v${latest.version}` : "Changelog" }}</span>
          <span v-if="latest" class="truncate">{{ latest.title }}</span>
          <UIcon name="i-lucide-arrow-right" class="size-3" aria-hidden="true" />
        </NuxtLink>

        <h1 class="mt-6 text-balance text-[40px] font-semibold leading-[1.08] tracking-[-0.035em] text-highlighted sm:text-[56px]">
          {{ page.sourceTitle }}
        </h1>
        <p class="mt-5 max-w-xl text-pretty text-lg leading-8 text-muted">
          {{ page.description }}
        </p>

        <div class="mt-8 flex flex-wrap items-center gap-3">
          <UButton to="/docs/getting-started" size="lg" color="neutral" trailing-icon="i-lucide-arrow-right" label="Get started" />
          <ClientOnly>
            <UButton v-if="loggedIn" to="https://console.vitehub.dev" external size="lg" color="neutral" variant="outline" icon="i-lucide-panels-top-left" label="Open the Console" />
            <UButton v-else to="/docs/this-site" size="lg" color="neutral" variant="outline" icon="i-lucide-pencil-ruler" label="Edit this site" />
            <template #fallback>
              <UButton to="/docs/this-site" size="lg" color="neutral" variant="outline" icon="i-lucide-pencil-ruler" label="Edit this site" />
            </template>
          </ClientOnly>
        </div>

        <div class="mt-8 flex h-10 max-w-sm items-center border border-default bg-muted/40 pl-3 font-mono text-sm">
          <span class="select-none text-dimmed" aria-hidden="true">$</span>
          <code class="ml-2 min-w-0 flex-1 truncate text-highlighted">{{ install }}</code>
          <UButton
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            color="neutral"
            variant="ghost"
            square
            class="h-full rounded-none border-l border-default px-3"
            :aria-label="copied ? 'Copied' : 'Copy the install command'"
            @click="copyInstall"
          />
        </div>
      </div>

      <LumenIllustration name="hero" eager alt="A folder of large photos goes into the Lumen machine on a conveyor and comes out as smaller images, next to a laptop that runs lumen, the config file, and a CI status tower." />
    </section>

    <UPageBody prose class="docs-content !mt-0 !px-0 !pb-0 pt-2">
      <DocsMarkdown :document="data!.document" :components="{ pre: resolveComponent('DocsCodePre') }" />
    </UPageBody>

    <section class="mt-16" aria-labelledby="landing-blog">
      <div class="flex items-baseline justify-between gap-4 border-b border-default pb-3">
        <h2 id="landing-blog" class="text-sm font-semibold text-highlighted">From the blog</h2>
        <NuxtLink to="/blog" class="text-sm text-muted hover:text-highlighted">All posts</NuxtLink>
      </div>
      <ul class="grid min-h-40 gap-px sm:grid-cols-3">
        <li v-for="post in posts ?? []" :key="post.id" class="border-b border-default sm:border-b-0">
          <NuxtLink :to="post.url" class="block h-full py-5 pr-6 transition-colors hover:text-highlighted">
            <time :datetime="post.date" class="text-xs text-muted">{{ formatDate(post.date) }}</time>
            <span class="mt-2 block text-balance font-medium leading-6 text-highlighted">{{ post.title }}</span>
            <span class="mt-1.5 line-clamp-2 text-sm leading-6 text-muted">{{ post.description }}</span>
          </NuxtLink>
        </li>
      </ul>
    </section>
  </div>
</template>
