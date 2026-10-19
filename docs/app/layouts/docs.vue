<script setup lang="ts">
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";
import { isDocsSiteArea } from "../composables/useDocsSection";

const route = useRoute();
// The catalog and every product Overview are landing pages: no sidebar, one centered column.
const isLanding = computed(() => isDocsLandingPath(docsManifest.sections, route.path));
const isDocsSiteAreaRoute = computed(() => isDocsSiteArea(route.path));

// On docs pages the sidebar sits on the left edge of the viewport. The page content centers in the remaining space.
const docsShellUi = {
  root: "lg:!flex lg:!flex-row lg:!items-start lg:!gap-0",
  left: "lg:!w-(--vh-sidebar-width) lg:shrink-0",
  center: "lg:!flex-1 lg:!min-w-0",
};
const supportMatrixUi = {
  ...docsShellUi,
  left: "lg:!w-(--vh-rail-width) lg:shrink-0",
};
</script>

<template>
  <UMain class="vh-docs-shell" :class="{ 'vh-docs-no-header': !isLanding && !isDocsSiteAreaRoute }">
    <UPage v-if="isSupportMatrix" :ui="supportMatrixUi">
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
      <AnnouncementBanner />
      <slot />
      <AppFooter class="vh-docs-footer" />
    </div>

    <UPage v-else class="vh-docs-shell" :ui="docsShellUi">
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
.vh-docs-shell {
  --ui-header-height: 0px;
}

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
.vh-docs-main {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
}

.vh-docs-landing {
  --vh-landing-width: 84rem;
  max-width: var(--vh-landing-width);
  margin-inline: auto;
}

/* On wide screens the rail and the page panel stay at the left edge. The page fills the remaining space. */
@media (min-width: 64rem) {
  .vh-docs-shell {
    display: flex;
    align-items: flex-start;
    overflow-x: clip;
  }
  /* The sidebars do not clip, so the expanded rail can cover the page. The z-index keeps it below the site header. */
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
    flex-direction: row;
    overflow: visible;
    border-right: 1px solid var(--ui-border);
    width: max-content;
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
