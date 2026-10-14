<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const isSupportMatrix = computed(() => normalizeDocsPath(route.path) === "/docs/frameworks-hosts/support-matrix");
// The catalog and every product Overview are landing pages: no sidebar, one centered column.
const isLanding = computed(() => isDocsLandingPath(docsManifest.sections, route.path));

// On docs pages the sidebar sits on the left edge of the viewport. The page content centers in the remaining space.
const docsShellUi = {
  root: "lg:!flex lg:!flex-row lg:!items-start lg:!gap-0",
  left: "lg:!w-(--vh-sidebar-width) lg:shrink-0",
  center: "lg:!flex-1 lg:!min-w-0",
};
</script>

<template>
  <UMain>
    <UContainer v-if="isSupportMatrix" class="vh-docs-content">
      <AnnouncementBanner />
      <slot />
      <AppFooter class="vh-docs-footer" />
    </UContainer>

    <div v-else-if="isLanding" class="vh-docs-landing vh-docs-content">
      <slot />
      <AppFooter class="vh-docs-footer" />
    </div>

    <UPage v-else :ui="docsShellUi">
      <template #left>
        <UPageAside class="vh-docs-aside">
          <DocsAsideLeftTop />
          <DocsAsideLeftBody />
        </UPageAside>
      </template>

      <div class="vh-docs-main vh-docs-content">
        <AnnouncementBanner />
        <slot />
        <AppFooter class="vh-docs-footer" />
      </div>
    </UPage>
  </UMain>
</template>

<style scoped>
.vh-docs-main,
.vh-docs-landing {
  margin: 0 auto;
  padding: 0 1rem;
}

.vh-docs-main {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
}

/* The content fills the space next to the sidebars. The page header, the page body, and the table of contents set their own insets.
   The site footer sits in this column, so the sidebars run the full height beside it. On short pages it rests at the bottom of the viewport. */
.vh-docs-content {
  display: flex;
  min-width: 0;
  min-height: calc(100dvh - var(--ui-header-height));
  flex-direction: column;
}

.vh-docs-footer {
  margin-top: auto;
}

.vh-docs-landing {
  max-width: var(--vh-landing-width);
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
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--ui-border);
  }
}
</style>
