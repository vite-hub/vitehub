<script setup lang="ts">
const trustLinks = [
  { label: "About", to: "/about" },
  { label: "Contact", to: "/contact" },
  { label: "Privacy", to: "/privacy" },
];
</script>

<template>
  <UFooter>
    <template #left>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        <span>© {{ new Date().getFullYear() }} ViteHub</span>
        <NuxtLink
          v-for="link in trustLinks"
          :key="link.to"
          :to="link.to"
          class="transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          {{ link.label }}
        </NuxtLink>
      </div>
    </template>

    <template #right>
      <AppFooterRight />
    </template>
  </UFooter>
</template>
