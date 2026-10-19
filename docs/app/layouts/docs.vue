<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const isSupportMatrix = computed(() => normalizeDocsPath(route.path) === "/docs/frameworks-hosts/support-matrix");
const isLanding = computed(() => isDocsLandingPath(docsManifest.sections, route.path));
const docsShellUi = {
  root: "lg:!flex lg:!flex-row lg:!gap-0",
  left: "lg:!w-(--vh-sidebar-width) lg:shrink-0",
  center: "lg:!flex-1 lg:!min-w-0",
};
const supportDocsShellUi = {
  ...docsShellUi,
  left: "lg:!w-(--vh-rail-width) lg:shrink-0",
};
</script>

<template>
  <UMain class="vh-docs-shell" :class="{ 'vh-docs-shell-support': isSupportMatrix }">
    <UPage v-if="isSupportMatrix" :ui="supportDocsShellUi" class="vh-docs-page">
      <template #left>
        <UPageAside class="vh-docs-aside hidden lg:flex">
          <DocsSidebars :panel="false" />
        </UPageAside>
      </template>
      <div class="vh-docs-main vh-docs-support-matrix">
        <AnnouncementBanner />
        <slot />
      </div>
    </UPage>

    <UPage v-else-if="isLanding" :ui="docsShellUi" class="vh-docs-page">
      <template #left>
        <UPageAside class="vh-docs-aside hidden lg:flex">
          <DocsSidebars panel />
        </UPageAside>
      </template>
      <div class="vh-docs-main vh-docs-landing">
        <AnnouncementBanner />
        <slot />
      </div>
    </UPage>

    <UPage v-else :ui="docsShellUi" class="vh-docs-page">
      <template #left>
        <UPageAside class="vh-docs-aside hidden lg:flex">
          <DocsSidebars panel />
        </UPageAside>
      </template>
      <div class="vh-docs-main">
        <AnnouncementBanner />
        <slot />
      </div>
    </UPage>

    <AppFooter class="vh-docs-footer" />
  </UMain>
</template>

<style scoped>
.vh-docs-shell {
  display: flex;
  min-height: calc(100dvh - var(--ui-header-height));
  flex-direction: column;
}
.vh-docs-page,
.vh-docs-content {
  flex: 1 1 auto;
  width: 100%;
}
.vh-docs-main,
.vh-docs-landing {
  margin: 0 auto;
  padding: 0 1rem;
}
.vh-docs-main { max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem); }
.vh-docs-support-matrix { max-width: none; }
.vh-docs-landing { max-width: 84rem; }
.vh-docs-footer { margin-top: auto; }
@media (min-width: 40rem) {
  .vh-docs-main, .vh-docs-landing { padding: 0 2rem; }
}
@media (min-width: 64rem) {
  .vh-docs-shell:not(.vh-docs-shell-support) { --ui-header-height: 0px; }
  .vh-docs-shell { overflow-x: clip; }
  .vh-docs-aside {
    position: sticky;
    z-index: 10;
    top: var(--ui-header-height);
    display: flex;
    flex: none;
    height: calc(100dvh - var(--ui-header-height));
  }
  :deep(.vh-docs-sidebars) {
    height: 100%;
    min-height: 0;
    flex-direction: row;
    overflow: visible;
    border-right: 1px solid var(--ui-border);
  }
  :deep(.vh-docs-panel) { max-height: calc(100dvh - var(--ui-header-height)); }
}
@media (min-width: 80rem) {
  .vh-docs-main:has(.has-code-panel) { max-width: none; }
}
</style>
