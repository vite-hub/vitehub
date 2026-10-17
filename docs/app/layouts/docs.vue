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
    <UContainer v-if="isSupportMatrix">
      <AnnouncementBanner />
      <slot />
    </UContainer>

    <div v-else-if="isLanding" class="vh-docs-landing">
      <slot />
    </div>

    <UPage v-else :ui="docsShellUi">
      <template #left>
        <UPageAside class="vh-docs-aside">
          <DocsAsideLeftTop />
          <DocsAsideLeftBody />
        </UPageAside>
      </template>

      <div class="vh-docs-main">
        <AnnouncementBanner />
        <slot />
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
