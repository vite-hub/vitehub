<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionForPath, isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const isSupportMatrix = computed(() => normalizeDocsPath(route.path) === "/docs/frameworks-hosts/support-matrix");
const isLanding = computed(() => isDocsLandingPath(docsManifest.sections, route.path));
const hasPanel = computed(
  () => !isSupportMatrix.value && Boolean(getDocsSectionForPath(docsManifest.sections, route.path)),
);
</script>

<template>
  <UMain class="vh-docs-shell">
    <UContainer v-if="isSupportMatrix" class="vh-docs-content">
      <AnnouncementBanner />
      <slot />
    </UContainer>

    <div v-else-if="isLanding" class="vh-docs-content vh-docs-landing">
      <slot />
    </div>

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
}

.vh-docs-main,
.vh-docs-landing {
  margin: 0 auto;
  padding: 0 1rem;
}

.vh-docs-landing {
  max-width: 84rem;
}

.vh-docs-footer {
  margin-top: auto;
}

@media (min-width: 40rem) {
  .vh-docs-main,
  .vh-docs-landing {
    padding: 0 2rem;
  }
}

@media (min-width: 64rem) {
  .vh-docs-shell {
    align-items: flex-start;
    overflow-x: clip;
  }

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

  :deep(.vh-docs-panel) {
    max-height: calc(100dvh - var(--ui-header-height));
  }
}
</style>
