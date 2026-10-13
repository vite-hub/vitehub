<script setup lang="ts">
import type { ContentPage } from "../composables/useDocsPage";

const props = defineProps<{
  page: ContentPage;
  tutorial?: boolean;
  reference?: boolean;
}>();

const tocLinks = computed(() => props.page.body?.toc?.links ?? []);
const pageUi = computed(() => ({
  root: tocLinks.value.length
    ? "!grid !grid-cols-1 !gap-0 lg:!grid-cols-1 lg:!gap-0 xl:!grid-cols-[minmax(0,1fr)_var(--vh-toc-width)] xl:!gap-10"
    : "!grid !grid-cols-1 !gap-0 lg:!grid-cols-1 lg:!gap-0",
  center: "min-w-0 lg:!col-span-1",
  right: "hidden xl:block xl:!col-span-1 xl:!w-full",
}));
const headerUi = {
  root: "!px-0 !pt-8 !pb-8 lg:!pt-10",
  title: "text-3xl font-semibold leading-tight text-highlighted text-pretty",
  description: "mt-3 text-base leading-relaxed text-muted text-pretty",
};
const outlineUi = {
  root: "!static !mx-0 !px-0",
  container: "!pt-0 !border-s-0 !ps-0",
  link: "!h-auto min-h-7 !py-1 leading-5",
  linkText: "!whitespace-normal !overflow-visible !text-clip",
  content: "!min-h-0",
};
const mobileTocUi = {
  root: "xl:hidden !static !px-0 !mx-0",
  container: "!border-s-0 !border-b !border-default !ps-0 !py-3",
  trigger: "!py-1 text-sm font-medium text-muted",
  content: "!pb-2",
};
</script>

<template>
  <article class="vh-docs-article">
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
        prose
        class="docs-content vh-article-body !px-0 !pb-16"
        :class="{ 'docs-tutorial-content': tutorial, 'docs-reference-content': reference }"
      >
        <ContentRenderer :value="page" />
      </UPageBody>

      <template v-if="tocLinks.length" #right>
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

<style scoped>
@media (max-width: 79.99rem) {
  .vh-mobile-outline :deep(button[data-slot="trigger"]),
  .vh-mobile-outline :deep([data-slot="trailingIcon"]) {
    display: flex;
  }

  .vh-mobile-outline :deep(p[data-slot="trigger"]),
  .vh-mobile-outline :deep([data-slot="content"]:not([data-state])) {
    display: none;
  }
}
</style>
