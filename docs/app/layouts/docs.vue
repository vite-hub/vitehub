<script setup lang="ts">
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
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
const supportMatrixUi = {
  ...docsShellUi,
  left: "lg:!w-(--vh-rail-width) lg:shrink-0",
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
        <UPageAside class="vh-docs-aside hidden lg:block">
          <DocsSidebars :panel="false" />
        </UPageAside>
      </template>

      <div :class="hasCodePanel ? 'vh-docs-split' : 'vh-docs-main'">
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

.vh-docs-main {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
}

.vh-docs-landing {
  --vh-landing-width: 84rem;
  max-width: var(--vh-landing-width);
  margin-inline: auto;
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
