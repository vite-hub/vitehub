<script setup lang="ts">
import { docsAppPath, docsRawPath, normalizeDocsPath } from "#docs/navigation"

import type { DocsPageResponse } from "@vite-hub/docs"

const route = useRoute()
const manifest = useDocsManifest()
const { site, appBase } = useDocsConfig()
const path = normalizeDocsPath(route.path)
// A Content preview can show a new draft outside the build-time manifest. Let the page request decide whether it exists.
const { data } = await useFetch<DocsPageResponse>(docsAppPath(`/api/_docs/page${path === "/" ? "/index" : path}.json`, appBase), { key: `docs:${path}` })
if (!data.value) throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true })
const response = data.value
const { page } = response

const isRoot = page.path === manifest.root?.path
// Content previews can change a page's layout or add a home page after the manifest was built.
const layout = page.layout !== "home" && (response.section || isRoot) ? "docs" : "default"
if (import.meta.client && route.meta.layout !== layout) {
  // The server has already rendered the manifest's layout. Finish hydrating it before switching shells.
  if (useNuxtApp().isHydrating) onNuxtReady(() => setPageLayout(layout))
  else setPageLayout(layout)
}
// A page outside the docs base has no section. It reads as a plain article under the site header.
const isStandalone = !response.section && !isRoot && page.layout !== "home"

// Agents can fetch the Markdown twin of the page instead of the HTML.
useHead({ link: [{ rel: "alternate", type: "text/markdown", href: `${site.url}${docsAppPath(docsRawPath(page.path), appBase)}` }] })
const section = manifest.sections.find(candidate => candidate.id === response.section)
useDocsSeo({
  title: page.seo?.title ?? page.sourceTitle,
  description: page.seo?.description ?? page.description,
  section: section && { title: section.title, path: docsAppPath(section.path, appBase) },
  image: page.seo?.image,
  type: isRoot || page.layout === "landing" || page.layout === "home" ? "page" : "article",
})
</script>

<template>
  <!-- The layout's UMain is the page's only main landmark. -->
  <div v-if="isStandalone" class="mx-auto w-full max-w-3xl px-4 pb-24 pt-14 sm:px-6 sm:pt-20 lg:px-8 lg:pt-24" :data-path="page.path">
    <UPageHeader
      :title="page.sourceTitle"
      :description="page.tagline ?? undefined"
      :ui="{
        root: 'border-b border-default px-0 pb-10 pt-0',
        title: 'text-balance text-[38px] leading-[46px] sm:text-[46px] sm:leading-[54px]',
        description: 'max-w-2xl text-pretty text-lg leading-8',
      }"
    />

    <UPageBody prose class="!max-w-none !px-0 !pb-0 pt-10">
      <DocsMarkdown :document="response.document" />
      <DocsPageCredits v-if="response.credits" :credits="response.credits" class="not-prose mt-10" />
    </UPageBody>
  </div>

  <div v-else-if="page.layout === 'home'" :data-path="page.path">
    <DocsMarkdown :document="response.document" />
    <DocsPageCredits v-if="response.credits" :credits="response.credits" class="mx-auto w-full max-w-(--vh-content-width) px-4 sm:px-6" />
  </div>

  <div v-else-if="page.layout === 'landing'" class="vh-docs-landing">
    <DocsLanding :response="response" :header="isRoot" />
  </div>

  <!-- Remount numbered steps when navigating between tutorials. -->
  <div v-else :key="page.layout === 'tutorial' ? page.path : undefined" :class="page.codePanel ? 'vh-docs-split' : 'vh-docs-main'">
    <DocsArticle :response="response" />
  </div>
</template>

<style scoped>
/* Below 40rem the article and the product landing set the only gutter, so the text keeps the width. */
.vh-docs-main,
.vh-docs-landing,
.vh-docs-split {
  margin: 0 auto;
}

.vh-docs-landing {
  padding: 0 1rem;
}

.vh-docs-main {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
}

.vh-docs-landing {
  max-width: 84rem;
}

@media (min-width: 40rem) {
  .vh-docs-main,
  .vh-docs-landing,
  .vh-docs-split {
    padding: 0 2rem;
  }
}

/* With the article padding, the prose starts just clear of the pinned navigation button. */
@media (min-width: 64rem) {
  .vh-docs-split {
    padding-left: 1.25rem;
  }
}

/* The code panel reaches the right edge of the page. */
@media (min-width: 80rem) {
  .vh-docs-split {
    padding-right: 0;
  }
}
</style>
