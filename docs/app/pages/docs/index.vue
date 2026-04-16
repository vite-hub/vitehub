<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { computed } from "vue";
import { useDocsPage } from "../../composables/useDocsPage";
import { useFrameworkPreference } from "../../composables/useFrameworkPreference";
import { getDocsPage, getDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";

definePageMeta({
  layout: "docs",
});

const { current: framework } = useFrameworkPreference();

const docsPage = getDocsPage("getting-started", "index");
const sourcePath = computed(() => getDocsPath("getting-started", framework.value));
const { data: rawDoc } = await useAsyncData(
  () => `docs:${sourcePath.value}`,
  () => queryCollection("docs").path(sourcePath.value).first(),
  { watch: [sourcePath] },
);

if (!docsPage) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { page } = useDocsPage(
  computed(() => "/docs"),
  rawDoc,
  { title: docsPage.title, sourceTitle: docsPage.sourceTitle, description: docsPage.description },
);
</script>

<template>
  <UPage v-if="page">
    <UPageHeader :title="page.title" :description="page.description">
      <template #links>
        <DocsPageHeaderLinks />
      </template>
    </UPageHeader>

    <UPageBody prose class="docs-content docs-root-content pb-0">
      <ContentRenderer :value="page" />
    </UPageBody>

    <template #right>
      <DocsAsideRight :page="page as any" />
    </template>
  </UPage>
</template>

<style scoped>
.docs-content :deep(h1:first-of-type) {
  display: none;
}

.docs-root-content :deep(.fw-group) {
  position: relative;
  max-width: 48rem;
  overflow: visible;
  padding-block: 1rem;
}

.docs-root-content :deep(.fw-group::before),
.docs-root-content :deep(.fw-group::after) {
  content: "";
  position: absolute;
  right: 0;
  width: 120px;
  height: 1px;
  background: color-mix(in oklab, var(--ui-border) 78%, transparent);
}

.docs-root-content :deep(.fw-group::before) {
  top: 0;
}

.docs-root-content :deep(.fw-group::after) {
  bottom: 0;
}

.docs-root-content :deep(.fw-group__tabs) {
  position: static;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
  width: max-content;
  margin: 0 0 1.25rem auto;
}

.docs-root-content :deep(.fw-group__tab) {
  position: relative;
  width: 2.1rem;
  height: 2.1rem;
  border: 0;
  background: transparent;
  opacity: 0.5;
  filter: grayscale(1);
  color: var(--ui-text-dimmed, var(--ui-text-muted, var(--ui-text)));
}

.docs-root-content :deep(.fw-group__tab:hover) {
  opacity: 0.75;
}

.docs-root-content :deep(.fw-group__tab--active) {
  border-color: transparent;
  background: transparent;
  opacity: 1;
  filter: none;
  color: var(--ui-text-highlighted, var(--ui-text));
}

.docs-root-content :deep(.fw-group__tab--active::after) {
  content: "";
  position: absolute;
  right: -0.28rem;
  top: 50%;
  width: 0.34rem;
  height: 0.34rem;
  border-radius: 999px;
  background: currentColor;
  transform: translateY(-50%);
}

.docs-root-content :deep(.fw-group__tab-icons) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.docs-root-content :deep(.fw-group__tab-icon) {
  width: 1.15rem;
  height: 1.15rem;
}

@media (min-width: 1024px) {
  .docs-root-content :deep(.fw-group__tabs) {
    position: absolute;
    top: 50%;
    right: calc(-7.5rem - 1rem);
    transform: translateY(-50%);
    margin: 0;
  }
}
</style>
