<script setup lang="ts">
const route = useRoute();
const isSupportMatrix = computed(
  () => route.path.replace(/\/+$/, "") === "/docs/frameworks-hosts/support-matrix",
);
</script>

<template>
  <UMain>
    <UContainer>
      <template v-if="isSupportMatrix">
        <AnnouncementBanner />
        <slot />
      </template>

      <UPage v-else>
        <template #left>
          <UPageAside>
            <DocsAsideLeftTop />
            <DocsAsideLeftBody />
          </UPageAside>
        </template>

        <AnnouncementBanner />
        <slot />
      </UPage>
    </UContainer>
  </UMain>
</template>
