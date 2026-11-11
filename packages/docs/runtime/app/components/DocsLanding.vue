<script setup lang="ts">
import type { DocsPageResponse } from "@vite-hub/docs"

// A landing is a wide Overview. A section Overview opens with its own hero in the Markdown, so it shows only the page
// actions above the body and ends with the catalog footer. The docs base page is the catalog itself: it keeps the
// page header and has no footer.
const props = defineProps<{
  response: DocsPageResponse
  header?: boolean
}>()

const section = useDocsSection()
const page = computed(() => props.response.page)
</script>

<template>
  <UPage v-if="header" :ui="withDocsTheme('page', { root: 'lg:!grid-cols-1 lg:!gap-0', center: 'lg:!col-span-1', right: 'hidden' })" :data-path="page.path">
    <UPageHeader :headline="page.eyebrow ?? undefined" :title="page.sourceTitle" :description="page.tagline ?? undefined">
      <template #links>
        <DocsPageHeaderLinks />
      </template>
    </UPageHeader>

    <UPageBody prose class="docs-content docs-catalog-content pb-16">
      <DocsMarkdown :document="response.document" />
      <DocsPageCredits v-if="response.credits" :credits="response.credits" class="not-prose mt-10" />
    </UPageBody>
  </UPage>

  <article v-else class="vh-product-landing" :data-path="page.path">
    <div class="vh-product-actions">
      <DocsPageHeaderLinks />
    </div>

    <UPageBody prose class="docs-content vh-product-body !px-0">
      <DocsMarkdown :document="response.document" />
      <DocsPageCredits v-if="response.credits" :credits="response.credits" class="not-prose mt-10" />
    </UPageBody>

    <!-- Below the content: its links work before it hydrates. -->
    <LazyDocsCatalogFooter hydrate-on-visible :current="section" />
  </article>
</template>

<style scoped>
/* The page header shows the title, so the catalog hides the h1 of its Markdown. A section hero keeps its own h1. */
.docs-catalog-content :deep(h1:first-of-type) {
  display: none;
}

/* The catalog spans the full page width. Its intro children keep the measure; a `.vh-docs-wide` block uses the width. */
.docs-catalog-content :deep(> .comark-content > :not(.vh-docs-wide)) {
  max-width: var(--vh-content-width);
}

/* The landing has no page header or page body padding, so it sets the same insets itself. Below 40rem the page gutter is the only one. */
.vh-product-landing {
  padding: 0 0 4rem;
}

@media (min-width: 40rem) {
  .vh-product-landing {
    padding-inline: 2rem;
  }
}

@media (min-width: 80rem) {
  .vh-product-landing {
    padding-inline: 3rem;
  }
}

.vh-product-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 1rem;
}

/* The landing body spans the full landing width. Its sections manage their own measure. */
.vh-product-body {
  padding-bottom: 0;
}
</style>
