<script setup lang="ts">
import type { ContentPage } from "../composables/useDocsPage";
import type { DocsSection } from "~~/modules/vitehub-docs/runtime/utils/docs";

// The Markdown body opens with `::product-hero` and continues with `::product-features`.
// This component appends the footer that lists every documented area.
const props = defineProps<{
  page: ContentPage;
  section: DocsSection;
}>();
</script>

<template>
  <article class="vh-product-landing">
    <div class="vh-product-actions">
      <DocsPageHeaderLinks />
    </div>

    <UPageBody prose class="docs-content vh-product-body !px-0">
      <ContentRenderer :value="page" />
    </UPageBody>

    <DocsProductFooter :current="section" />
  </article>
</template>

<style scoped>
/* The landing has no page header or page body padding, so it sets the same insets itself. */
.vh-product-landing {
  padding: 0 1rem 4rem;
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
