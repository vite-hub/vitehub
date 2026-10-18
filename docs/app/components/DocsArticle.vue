<script setup lang="ts">
import type { ComponentPublicInstance } from "vue";
import type { ContentPage } from "../composables/useDocsPage";

const props = defineProps<{
  page: ContentPage;
  tutorial?: boolean;
  reference?: boolean;
}>();

const tocLinks = computed(() => props.page.body?.toc?.links ?? []);
const section = useDocsSection();
// A tutorial with `codePanel: true` splits in half on wide screens: the prose on the left, its files on the right.
const hasCodePanel = computed(() => props.tutorial && props.page.codePanel === true);
const body = useTemplateRef<ComponentPublicInstance>("body");
const bodyElement = computed(() => {
  const element: unknown = body.value?.$el;
  return import.meta.client && element instanceof HTMLElement ? element : null;
});
const pageUi = computed(() => ({
  root: hasCodePanel.value
    ? "!grid !grid-cols-1 !gap-0 lg:!grid-cols-1 lg:!gap-0 xl:!grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] xl:!gap-10"
    : tocLinks.value.length
    ? "!grid !grid-cols-1 !gap-0 lg:!grid-cols-1 lg:!gap-0 xl:!grid-cols-[minmax(0,1fr)_var(--vh-toc-width)] xl:!gap-10"
    : "!grid !grid-cols-1 !gap-0 lg:!grid-cols-1 lg:!gap-0",
  center: "min-w-0 lg:!col-span-1",
  right: "hidden xl:block xl:!col-span-1 xl:!w-full",
}));
const headerUi = {
  root: "!px-0 !pt-8 !pb-8 lg:!pt-10",
  title: "text-4xl/tight tracking-[-0.02em] font-semibold text-highlighted text-balance",
  description: "mt-3 text-base leading-relaxed text-muted text-pretty",
};
const outlineUi = {
  root: "!static !mx-0 !px-0",
  container: "!pt-0 !border-s-0 !ps-0",
  link: "!h-auto min-h-7 !py-1 leading-5 !text-muted hover:!text-highlighted",
  linkText: "!whitespace-normal !overflow-visible !text-clip",
  content: "!min-h-0",
};
const mobileTocUi = {
  root: "xl:hidden !static !px-0 !mx-0",
  container: "!border-s-0 !border-b !border-default !ps-0 !py-3",
  trigger: "!py-1 text-sm font-medium text-muted",
  content: "!pb-2",
  link: "!text-muted hover:!text-highlighted",
};
</script>

<template>
  <article class="vh-docs-article" :class="{ 'has-code-panel': hasCodePanel }">
    <UPage :ui="pageUi">
      <UPageHeader :title="page.title" :description="page.description" :ui="headerUi">
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
        :ui="mobileTocUi"
      />

      <UPageBody
        ref="body"
        prose
        class="docs-content vh-article-body !px-0 !pb-16"
        :class="{ 'docs-tutorial-content': tutorial, 'docs-reference-content': reference }"
      >
        <ContentRenderer :value="page" :components="{ pre: DocsCodePre }" />
      </UPageBody>

      <!-- Every page ends with the full product list, in the content column. -->
      <DocsProductFooter :current="section" class="vh-article-explore" />

      <template v-if="hasCodePanel" #right>
        <DocsCodePanel :body="bodyElement" />
      </template>

      <template v-else-if="tocLinks.length" #right>
        <aside class="vh-article-outline" aria-label="Page outline">
          <UContentToc title="On this page" :highlight="false" :links="tocLinks" :ui="outlineUi" />
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
  padding-inline: 1.25rem;
}

.vh-article-body {
  min-width: 0;
}

/* Beside the code panel the article spans the page column, and the panel reaches the right edge. */
@media (min-width: 80rem) {
  .vh-docs-article.has-code-panel {
    max-width: none;
    padding-right: 0;
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
  padding-block: 2.5rem;
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
