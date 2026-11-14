<script setup lang="ts">
import { contentField } from "vite-hub/content/client"

import type { DocsDocument } from "@vite-hub/docs"

// One release of the changelog: the version and the date on the left, the notes on the right.
const props = defineProps<{
  release: { id: string, url: string, version: string, title: string, date: string, breaking: boolean, document: DocsDocument }
  /** The heading level of the version: 1 on the page of one release, 2 in the list. */
  level?: 1 | 2
}>()

const field = (name: string) => contentField("changelog", props.release.id, name)
</script>

<template>
  <section :id="release.id" class="grid scroll-mt-24 gap-4 border-b border-default py-10 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10">
    <div class="md:sticky md:top-24 md:self-start">
      <component :is="level === 1 ? 'h1' : 'h2'" class="font-mono text-lg font-semibold text-highlighted">
        <NuxtLink :to="release.url" class="hover:underline hover:underline-offset-4" v-bind="field('version')">v{{ release.version }}</NuxtLink>
      </component>
      <time :datetime="release.date" class="mt-1 block text-sm text-muted">{{ formatDate(release.date) }}</time>
      <UBadge v-if="release.breaking" label="Breaking" color="warning" variant="subtle" size="sm" class="mt-3" />
    </div>
    <div class="min-w-0">
      <p class="text-balance text-xl font-semibold leading-7 tracking-[-0.01em] text-highlighted" v-bind="field('title')">{{ release.title }}</p>
      <UPageBody prose class="docs-content !mt-0 !px-0 !pb-0 pt-2" v-bind="field('body')">
        <DocsMarkdown :document="release.document" :components="{ pre: resolveComponent('DocsCodePre') }" />
      </UPageBody>
    </div>
  </section>
</template>
