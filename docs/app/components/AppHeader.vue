<script setup lang="ts">
const primaryLinks = [
  { label: "Home", to: "/" },
  { label: "Docs", to: "/docs" },
];
</script>

<template>
  <div class="sticky top-0 z-50">
    <UHeader :to="'/'" title="ViteHub" :links="primaryLinks">
      <template #title>
        <img src="/favicon.svg" alt="ViteHub" class="h-6 w-auto shrink-0">
        <span>ViteHub</span>
      </template>

      <template #right>
        <PackageSelector />
        <UContentSearchButton class="hidden lg:inline-flex" />
        <ClientOnly>
          <UColorModeButton />
          <template #fallback>
            <div class="size-8 animate-pulse rounded-md bg-muted" />
          </template>
        </ClientOnly>
        <UButton
          to="https://github.com/vite-hub/vitehub"
          target="_blank"
          icon="i-simple-icons-github"
          variant="ghost"
          color="neutral"
          aria-label="ViteHub on GitHub"
        />
      </template>
    </UHeader>
  </div>
</template>
