<script setup lang="ts">
// Every published release of the `changelog` collection, newest first.
const { data: releases } = await useFetch("/api/changelog", { key: "changelog" })

useSeoMeta({ title: "Changelog", description: "What changed in each Lumen release." })
useHead({ link: [{ rel: "alternate", type: "application/rss+xml", title: "Lumen changelog", href: "/changelog/rss.xml" }] })
</script>

<template>
  <div class="mx-auto w-full max-w-4xl px-4 pb-24 pt-14 sm:px-6 sm:pt-20 lg:px-8">
    <header class="flex items-end justify-between gap-6 border-b border-default pb-8">
      <div>
        <h1 class="text-balance text-[38px] font-semibold leading-[46px] tracking-[-0.03em] text-highlighted">Changelog</h1>
        <p class="mt-3 text-pretty text-lg leading-8 text-muted">What changed in each Lumen release. Upgrade with <code class="font-mono text-base text-highlighted">pnpm add -g lumen-cli@latest</code>.</p>
      </div>
      <UButton to="/changelog/rss.xml" external target="_blank" icon="i-lucide-rss" label="RSS" color="neutral" variant="outline" size="sm" />
    </header>

    <template v-if="releases?.length">
      <LumenRelease v-for="release in releases" :key="release.id" :release="release" />
    </template>
    <div v-else class="flex flex-col items-center py-16 text-center">
      <LumenIllustration name="reference" alt="A drawer cabinet, a stack of books, a config sheet, and a status tower." class="w-full max-w-xs" />
      <h2 class="mt-6 font-semibold text-highlighted">No releases yet</h2>
      <p class="mt-2 max-w-sm text-pretty text-sm leading-6 text-muted">Publishers add releases in the Console. A published release shows here on the next visit.</p>
    </div>
  </div>
</template>
