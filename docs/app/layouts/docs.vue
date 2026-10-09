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
    </div>
  </UMain>
</template>

<style scoped>
/* The header menu holds the navigation on narrow screens. The child selector outranks the DocsSidebars root rule. */
.vh-docs-shell > .vh-docs-desktop-nav {
  display: none;
}

/* The content fills the space next to the sidebars. The page header, the page body, and the table of contents set their own insets. */
.vh-docs-content {
  min-width: 0;
  max-width: none;
}

/* On wide screens the rail and the page panel stay at the left edge. The page fills the remaining space. */
@media (min-width: 64rem) {
  .vh-docs-shell {
    display: flex;
    align-items: flex-start;
  }

  /* The sidebars do not clip, so the expanded rail can cover the page. The z-index keeps it below the site header. */
  .vh-docs-shell > .vh-docs-desktop-nav {
    position: sticky;
    z-index: 10;
    top: var(--ui-header-height);
    display: flex;
    flex: none;
    height: calc(100dvh - var(--ui-header-height));
  }

  .vh-docs-content {
    flex: 1;
  }
}
</style>
