<script setup lang="ts">
import { docsManifest, getDocsPageByPath, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
// The support matrix brings its own navigation panel and needs the full width for its table.
const isSupportMatrix = computed(() => normalizeDocsPath(route.path) === "/docs/frameworks-hosts/support-matrix");
// The catalog and every product Overview are landing pages: no sidebar, one centered column.
const isLanding = computed(() => isDocsLandingPath(docsManifest.sections, route.path));
const hasCodePanel = computed(() => getDocsPageByPath(normalizeDocsPath(route.path))?.codePanel === true);

// On docs pages the sidebar sits on the left edge of the viewport. The page content centers in the remaining space.
const docsShellUi = {
  root: "lg:!flex lg:!flex-row lg:!items-start lg:!gap-0",
  left: "lg:!w-(--vh-sidebar-width) lg:shrink-0",
  center: "lg:!flex-1 lg:!min-w-0",
};
</script>

<template>
  <UMain class="vh-docs-shell" :class="{ 'has-header': isSupportMatrix }">
    <UContainer v-if="isSupportMatrix">
      <AnnouncementBanner />
      <slot />
    </UContainer>

    <div v-else-if="isLanding" class="vh-docs-landing">
      <slot />
    </div>

    <UPage v-else :ui="docsShellUi">
      <template #left>
        <UPageAside class="vh-docs-aside hidden lg:flex">
          <DocsSidebars class="vh-docs-aside-sidebars" panel />
        </UPageAside>
      </template>

      <div :class="hasCodePanel ? 'vh-docs-split' : 'vh-docs-main'">
        <AnnouncementBanner />
        <slot />
      </div>
    </UPage>
  </UMain>
</template>

<style scoped>
.vh-docs-main,
.vh-docs-landing,
.vh-docs-split {
  margin: 0 auto;
  padding: 0 1rem;
}

.vh-docs-main {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
}

.vh-docs-landing {
  max-width: 84rem;
}

.vh-docs-split {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
}

@media (min-width: 80rem) {
  .vh-docs-split { padding-right: 0; }
}

@media (min-width: 40rem) {
  .vh-docs-main,
  .vh-docs-landing,
  .vh-docs-split {
    padding: 0 2rem;
  }
}

@media (min-width: 64rem) {
  /* AppHeader hides itself on wide docs pages. Sticky offsets and full-height columns read this variable. */
  .vh-docs-shell:not(.has-header) {
    --ui-header-height: 0px;
  }

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

  /* The aside container is a flex column. Without a flex basis the sidebars shrink to the rail header and the panel loses its page list. */
  .vh-docs-aside-sidebars {
    min-height: 0;
    flex: 1 1 0;
  }

  /* A denser rail on desktop, so every product fits without scrolling on common laptop heights. The mobile menu keeps touch-size items. */
  .vh-docs-aside-sidebars :deep(.vh-primitive-rail) {
    --vh-primitive-rail-item: 2rem;
  }

  .vh-docs-aside-sidebars :deep(.vh-primitive-rail__surface) {
    padding-block: 0.25rem;
  }

  .vh-docs-aside-sidebars :deep(.vh-primitive-rail__group) {
    gap: 0;
    padding-block: 0.1875rem;
  }

  /* The aside draws the right border. */
  .vh-docs-aside-sidebars :deep(.vh-docs-panel) {
    border-right: 0;
  }
}
</style>
