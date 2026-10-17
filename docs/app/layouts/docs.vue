<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionForPath, isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const isSupportMatrix = computed(() => normalizeDocsPath(route.path) === "/docs/frameworks-hosts/support-matrix");
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
          <DocsSidebars :panel="false" />
        </UPageAside>
      </template>
      <div class="vh-docs-main vh-docs-support-matrix">
        <AnnouncementBanner />
        <slot />
        <AppFooter class="vh-docs-footer" />
      </div>
    </UPage>

    <div v-else-if="isLanding" class="vh-docs-landing">
      <slot />
      <AppFooter class="vh-docs-footer" />
    </div>

    <UPage v-else :ui="docsShellUi">
      <template #left>
        <UPageAside class="vh-docs-aside hidden lg:block">
          <DocsSidebars panel />
        </UPageAside>
      </template>
      <div class="vh-docs-main">
        <AnnouncementBanner />
        <slot />
        <AppFooter class="vh-docs-footer" />
      </div>
    </UPage>
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
  flex: 1;
  min-width: 0;
  max-width: none;
  min-height: calc(100dvh - var(--ui-header-height));
  flex-direction: column;
}

.vh-docs-support-matrix {
  max-width: none;
  width: 100%;
}

.vh-docs-landing {
  max-width: var(--vh-landing-width);
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

  :deep(.vh-docs-sidebars) {
    height: 100%;
    min-height: 0;
  }

  :deep(.vh-docs-panel) {
    max-height: calc(100dvh - var(--ui-header-height));
  }

  /* Keep the actual sidebar element's columns and border constrained to the viewport. */
  :deep(.vh-docs-sidebars) {
    flex-direction: row;
    overflow: visible;
    border-right: 1px solid var(--ui-border);
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
