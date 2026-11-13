<script setup lang="ts">
import DocsCodePre from "./DocsCodePre.vue"

import type { ComponentPublicInstance } from "vue"
import type { DocsPageResponse } from "@vite-hub/docs"

const props = defineProps<{
  response: DocsPageResponse
}>()

const page = computed(() => props.response.page)
const tutorial = computed(() => page.value.layout === "tutorial")
const tocLinks = computed(() => page.value.toc ? props.response.document.toc : [])
const section = useDocsSection()
// A tutorial with `codePanel: true` splits in half on wide screens: the prose on the left, its files on the right.
const hasCodePanel = computed(() => tutorial.value && page.value.codePanel === true)
const body = useTemplateRef<ComponentPublicInstance>("body")
const bodyElement = computed(() => {
  const element: unknown = body.value?.$el
  return import.meta.client && element instanceof HTMLElement ? element : null
})
const pageUi = computed(() => ({
  root: hasCodePanel.value
    ? "!grid !grid-cols-1 !gap-0 lg:!grid-cols-1 lg:!gap-0 xl:!grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] xl:!gap-8"
    : tocLinks.value.length
    ? "!grid !grid-cols-1 !gap-0 lg:!grid-cols-1 lg:!gap-0 xl:!grid-cols-[minmax(0,1fr)_var(--vh-toc-width)] xl:!gap-10"
    : "!grid !grid-cols-1 !gap-0 lg:!grid-cols-1 lg:!gap-0",
  center: "min-w-0 lg:!col-span-1",
  // The outline is 0.5rem wider than its column and pulled back by its negative margin, so the padding that keeps focus
  // rings whole does not narrow the links.
  right: hasCodePanel.value ? "hidden xl:block xl:!col-span-1 xl:!w-full" : "hidden xl:block xl:!col-span-1 xl:!w-[calc(100%+0.5rem)]",
}))
const headerUi = {
  root: "!px-0 !pt-10 !pb-0",
  title: "text-[2rem] sm:text-[2rem] leading-[1.15] tracking-[-0.025em] font-semibold text-highlighted text-balance",
  description: "mt-2 max-w-[34rem] text-[1.0625rem] leading-[1.7] text-muted text-pretty",
}
// The aside scrolls the outline. The list and its root do not scroll too, so only the aside clips, and its padding keeps
// the focus ring of a link whole.
const outlineUi = {
  root: "!static !mx-0 !px-0 !overflow-visible",
  container: "!pt-0 !border-s-0 !ps-0",
  link: "!h-auto min-h-6 !py-1 text-[0.8125rem] leading-5 !text-dimmed hover:!text-highlighted data-[active]:!text-highlighted",
  // Long code headings such as KV_UNSUPPORTED_OPERATION have no spaces, so they break anywhere instead of overflowing the column.
  linkText: "!whitespace-normal !overflow-visible !text-clip [overflow-wrap:anywhere]",
  content: "!min-h-0 !overflow-visible",
}
const mobileTocUi = {
  // The page body has no top margin, so the outline keeps the space that separates it from the first heading.
  root: "xl:hidden !static !px-0 !mx-0 mb-6",
  container: "!border-s-0 !border-b !border-default !ps-0 !py-3",
  // Touch screens get a 44px toggle.
  trigger: "!py-1 pointer-coarse:min-h-11 text-sm font-medium text-muted",
  content: "!pb-2",
  link: "!text-muted hover:!text-highlighted",
}
</script>

<template>
  <article class="vh-docs-article" :class="{ 'has-code-panel': hasCodePanel }" :data-path="page.path">
    <UPage :ui="withDocsTheme('page', pageUi)">
      <UPageHeader :headline="page.eyebrow ?? undefined" :title="page.sourceTitle" :description="page.tagline ?? undefined" :ui="withDocsTheme('pageHeader', headerUi)">
        <template #links>
          <DocsPageHeaderLinks />
        </template>
      </UPageHeader>

      <UContentToc
        v-if="tocLinks.length"
        class="vh-mobile-outline"
        title="On this page"
        :highlight="false"
        :links="tocLinks"
        :ui="withDocsTheme('contentToc', mobileTocUi)"
      />

      <UPageBody
        ref="body"
        prose
        class="docs-content vh-article-body !px-0 !pb-16"
        :class="{ 'docs-tutorial-content': tutorial }"
      >
        <!-- Code is comark-ui's code block, except beside a code panel, which reads the file name bar of DocsCodePre. -->
        <DocsMarkdown :document="response.document" :components="hasCodePanel ? { pre: DocsCodePre } : undefined" />
        <DocsPageCredits v-if="response.credits" :credits="response.credits" class="not-prose mt-10" />
      </UPageBody>

      <!-- Every page ends with the full product list, in the content column. -->
      <!-- Below the content: its links work before it hydrates. -->
      <LazyDocsCatalogFooter hydrate-on-visible :current="section" class="vh-article-explore" />

      <template v-if="hasCodePanel" #right>
        <DocsCodePanel :body="bodyElement" />
      </template>

      <template v-else-if="tocLinks.length" #right>
        <aside class="vh-article-outline" aria-label="Page outline">
          <UContentToc title="On this page" :highlight="false" :links="tocLinks" :ui="withDocsTheme('contentToc', outlineUi)" />
        </aside>
      </template>
    </UPage>
  </article>
</template>

<style scoped>
.vh-docs-article {
  width: 100%;
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 6rem);
  margin-inline: auto;
  padding-inline: 1rem;
}

/* Below 40rem this is the only gutter. Wider pages add the page padding around it. */
@media (min-width: 40rem) {
  .vh-docs-article {
    padding-inline: 1.25rem;
  }
}

.vh-article-body {
  min-width: 0;
}

/* Beside the code panel the article spans the page column, and the panel reaches the right edge. */
@media (min-width: 80rem) {
  .vh-docs-article.has-code-panel {
    max-width: none;
    padding-right: 0;
    padding-left: 1.5rem;
  }
}

/* The page body already ends with padding, so the list drops its own top margin. */
.vh-docs-article .vh-article-explore {
  margin-top: 0;
  margin-bottom: 4rem;
}

.vh-article-body :deep(h1:first-child) {
  display: none;
}

.docs-tutorial-content {
  counter-reset: tutorial-step;
}

.vh-article-outline {
  position: sticky;
  align-self: start;
  top: calc(var(--ui-header-height) + 2rem);
  max-height: calc(100dvh - var(--ui-header-height) - 4rem);
  overflow-y: auto;
  margin-inline: -0.25rem;
  padding: 2.5rem 0.25rem;
}

@media (min-width: 40rem) {
  .vh-docs-article {
    padding-inline: 2rem;
  }
}
</style>

<!--
  Nuxt UI opens the outline from the lg breakpoint, but the right column starts at xl.
  Between the two, keep the collapsed toggle. UContentToc's root does not carry this component's scope, so these rules are global.
-->
<style>
@media (max-width: 79.99rem) {
  .vh-mobile-outline button[data-slot="trigger"],
  .vh-mobile-outline [data-slot="trailingIcon"] {
    display: flex;
  }

  .vh-mobile-outline [data-slot="content"][data-state="open"] {
    display: block;
  }

  .vh-mobile-outline p[data-slot="trigger"],
  .vh-mobile-outline [data-slot="content"]:not([data-state]) {
    display: none;
  }
}
</style>
