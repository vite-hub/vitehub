<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const isSupportMatrix = computed(() => normalizeDocsPath(route.path) === "/docs/frameworks-hosts/support-matrix");
// The catalog and every product Overview are landing pages: no sidebar, one centered column.
const isLanding = computed(() => isDocsLandingPath(docsManifest.sections, route.path));
const docsShellUi = {
  root: "lg:!flex lg:!flex-row lg:!items-start lg:!gap-0",
  left: "lg:!w-(--vh-sidebar-width) lg:shrink-0",
  center: "lg:!flex-1 lg:!min-w-0",
};
</script>

<template>
  <UMain>
    <UPage v-if="isSupportMatrix" :ui="docsShellUi">
      <template #left>
        <UPageAside class="vh-docs-aside hidden lg:block">
          <DocsAsideLeftTop />
          <DocsAsideLeftBody />
        </UPageAside>
      </template>

<style scoped>
.vh-docs-main,
.vh-docs-landing {
  margin: 0 auto;
  padding: 0 1rem;
}

/* The content fills the space next to the sidebars. The page header, the page body, and the table of contents set their own insets.
   The site footer sits in this column, so the sidebars run the full height beside it. On short pages it rests at the bottom of the viewport. */
.vh-docs-content {
  display: flex;
  min-width: 0;
  max-width: none;
  flex: 1;
  min-height: calc(100dvh - var(--ui-header-height));
  flex-direction: column;
}

.vh-docs-main {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
}

.vh-docs-support-matrix {
  max-width: none;
  width: 100%;
}

.vh-docs-landing {
  max-width: var(--vh-landing-width);
}

.vh-docs-footer {
  margin-top: 3rem;
}

/* On wide screens the rail and the page panel stay at the left edge. The page fills the remaining space. */
@media (min-width: 64rem) {
  .vh-docs-shell {
    display: flex;
    align-items: flex-start;
    /* Keep the expanded rail surface visible outside its collapsed width. */
    overflow: visible;
  }
}

@media (min-width: 40rem) {
  .vh-docs-main,
  .vh-docs-landing {
    padding: 0 2rem;
  }
}

@media (min-width: 64rem) {
  .vh-docs-aside {
    position: sticky;
    top: var(--ui-header-height);
    display: flex;
    height: calc(100dvh - var(--ui-header-height));
    max-height: calc(100dvh - var(--ui-header-height));
    min-height: calc(100dvh - var(--ui-header-height));
    flex: 0 0 auto;
    flex-direction: column;
    overflow: visible;
    border-right: 1px solid var(--ui-border);
  }

  .vh-docs-content {
    flex: 1;
  }

  :deep(.vh-docs-sidebars) {
    height: 100%;
    min-height: 0;
    flex-direction: row;
    overflow: visible;
    border-right: 1px solid var(--ui-border);
  }

  :deep(.vh-docs-panel) {
    max-height: calc(100dvh - var(--ui-header-height));
  }
}
</style>
