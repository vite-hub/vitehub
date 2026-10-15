<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionForPath, isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const isSupportMatrix = computed(() => normalizeDocsPath(route.path) === "/docs/frameworks-hosts/support-matrix");
// The catalog and every product Overview are landing pages: one full-width column without a table of contents.
const isLanding = computed(() => isDocsLandingPath(docsManifest.sections, route.path));
// The rail is on every docs page. The page panel opens next to it inside a section, including its Overview.
// The support matrix keeps the full width for its table.
const hasPanel = computed(
  () => !isSupportMatrix.value && Boolean(getDocsSectionForPath(docsManifest.sections, route.path)),
);
</script>

<template>
  <UMain class="vh-docs-shell">
    <DocsSidebars class="vh-docs-desktop-nav" :panel="hasPanel" />

    <div class="vh-docs-content">
      <UContainer v-if="isSupportMatrix">
        <AnnouncementBanner />
        <slot />
      </UContainer>

      <slot v-else-if="isLanding" />

      <template v-else>
        <AnnouncementBanner />
        <slot />
      </template>

      <AppFooter class="vh-docs-footer" />
    </div>
  </UMain>
</template>

<style scoped>
/* The header menu holds the navigation on narrow screens. The child selector outranks the DocsSidebars root rule. */
.vh-docs-shell > .vh-docs-desktop-nav {
  display: none;
}

/* The content fills the space next to the sidebars. The page header, the page body, and the table of contents set their own insets.
   The site footer sits in this column, so the sidebars run the full height beside it. On short pages it rests at the bottom of the viewport. */
.vh-docs-content {
  display: flex;
  min-width: 0;
  max-width: none;
  min-height: calc(100dvh - var(--ui-header-height));
  flex-direction: column;
}

.vh-docs-footer {
  margin-top: auto;
}

/* On wide screens the rail and the page panel stay at the left edge. The page fills the remaining space. */
@media (min-width: 64rem) {
  .vh-docs-shell {
    display: flex;
  }

  .vh-docs-shell > .vh-docs-desktop-nav {
    display: flex;
    position: sticky;
    top: var(--ui-header-height);
    height: calc(100dvh - var(--ui-header-height));
    max-height: calc(100dvh - var(--ui-header-height));
    min-height: calc(100dvh - var(--ui-header-height));
    flex: 0 0 auto;
  }

  .vh-docs-shell > .vh-docs-desktop-nav :deep(.vh-docs-sidebars) {
    width: max-content;
    height: 100%;
  }

  .vh-docs-shell > .vh-docs-desktop-nav :deep(.vh-docs-aside) {
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

  .vh-docs-content {
    flex: 1;
  }
}
</style>
