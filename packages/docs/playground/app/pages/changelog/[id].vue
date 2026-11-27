<script setup lang="ts">
// One release. The list of every release has it too; this page is its URL in the Console preview, the feed, and links.
const route = useRoute()
const id = String(route.params.id)
const { data: releases } = await useFetch("/api/changelog", { key: "changelog" })
const release = computed(() => releases.value?.find(entry => entry.id === id))
if (!release.value) throw createError({ statusCode: 404, statusMessage: "Release not found", fatal: true })

useSeoMeta({ title: `Lumen ${release.value.version}`, description: release.value.title })
</script>

<template>
  <div v-if="release" class="mx-auto w-full max-w-4xl px-4 pb-24 pt-10 sm:px-6 sm:pt-14 lg:px-8">
    <NuxtLink to="/changelog" class="inline-flex items-center gap-1.5 text-sm text-muted hover:text-highlighted">
      <UIcon name="i-lucide-arrow-left" class="size-3.5" aria-hidden="true" />
      Changelog
    </NuxtLink>
    <LumenRelease :release="release" :level="1" />
  </div>
</template>
