<script setup lang="ts">
const route = useRoute();
const primaryLinks = [
  { label: "Home", to: "/" },
  { label: "Docs", to: "/docs" },
  { label: "Blog", to: "/blogs/vite", match: "/blogs" },
];

function isActiveLink(link: typeof primaryLinks[number]) {
  if (link.match) return route.path.includes(link.match);
  const { to } = link;
  if (to === "/") return route.path === "/";
  return route.path === to || route.path.startsWith(`${to}/`);
}
</script>

<template>
  <div class="sticky top-0 z-50">
    <UHeader :to="'/'" title="ViteHub">
      <template #title>
        <UColorModeImage
          light="/vitehub-logo-header.png"
          dark="/vitehub-logo-header-dark.png"
          alt="ViteHub"
          class="h-7 w-auto shrink-0 self-baseline"
        />
      </template>

      <nav class="hidden items-center gap-1 lg:flex">
        <UButton
          v-for="link in primaryLinks"
          :key="link.to"
          :to="link.to"
          :label="link.label"
          :color="isActiveLink(link) ? 'primary' : 'neutral'"
          variant="ghost"
          size="sm"
        />
        <PackageSelector />
      </nav>

      <template #right>
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

      <template #body>
        <nav class="grid gap-1">
          <UButton
            v-for="link in primaryLinks"
            :key="link.to"
            :to="link.to"
            :label="link.label"
            :color="isActiveLink(link) ? 'primary' : 'neutral'"
            variant="ghost"
            block
            class="justify-start"
          />
        </nav>
      </template>
    </UHeader>
  </div>
</template>
