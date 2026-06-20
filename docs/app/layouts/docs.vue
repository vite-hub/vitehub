<template>
  <UMain>
    <UContainer>
      <UPage>
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
