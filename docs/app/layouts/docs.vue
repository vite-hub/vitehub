<script setup lang="ts">

// The sidebar sits on the left edge of the viewport. The page content centers in the remaining space.
const docsShellUi = {
  root: "lg:!flex lg:!flex-row lg:!items-start lg:!gap-0",
  left: "lg:!w-(--vh-sidebar-width) lg:shrink-0",
  center: "lg:!flex-1 lg:!min-w-0",
};
</script>

<template>
  <UMain>
    <UPage :ui="docsShellUi">
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
.vh-docs-main {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
  margin: 0 auto;
  padding: 0 1rem;
}

@media (min-width: 40rem) {
  .vh-docs-main {
    padding: 0 2rem;
  }
}

@media (min-width: 64rem) {
  .vh-docs-aside {
    border-right: 1px solid var(--ui-border);
  }
}
</style>
