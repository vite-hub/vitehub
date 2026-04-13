<script setup lang="ts">
import { useFrameworkPreference } from "../../composables/useFrameworkPreference";
import { docsManifest, getDocsPath } from "../../utils/docs";
import { normalizeSitePath } from "../../utils/docs-routes";

const route = useRoute();
const { current } = useFrameworkPreference();

const isDocsRoute = computed(() => {
  const p = normalizeSitePath(route.path);
  return p === "/docs" || p.startsWith("/docs/");
});

const primaryLinks = computed(() => [
  { label: "Home", to: "/" },
  { label: "Docs", to: "/docs" },
]);

type PackageLink = {
  label: string;
  icon?: string;
  to: string;
};

// Build-time package list, only framework prefix changes at runtime
const packageLinks = computed(() => {
  const links: PackageLink[] = [];

  for (const sectionMeta of docsManifest.packageSections) {
    const section = docsManifest.sections.find(item => item.id === sectionMeta.id);
    const primaryPage = section?.pages.find(page => page.id === "index")
      || section?.pages[0];

    if (!section || !primaryPage) {
      continue;
    }

    links.push({
      label: sectionMeta.title,
      icon: sectionMeta.icon || undefined,
      to: getDocsPath(sectionMeta.id, current.value, primaryPage.id),
    });
  }

  return links;
});
</script>

<template>
  <div class="sticky top-0 z-50">
    <UHeader :to="'/'" title="ViteHub" :links="primaryLinks">
      <template #title>
        <img src="/favicon.svg" alt="ViteHub" class="h-6 w-auto shrink-0">
        <span>ViteHub</span>
      </template>

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
    </UHeader>

    <div v-if="isDocsRoute && packageLinks.length" class="border-b border-default bg-default/75 backdrop-blur">
      <UContainer class="hidden overflow-x-auto lg:flex">
        <nav class="flex items-center gap-1 py-2">
          <NuxtLink
            v-for="link in packageLinks" :key="link.to" :to="link.to"
            class="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors"
            :class="route.path.includes(`/${link.to.split('/').pop()}/`) || route.path.endsWith(`/${link.to.split('/').pop()}`)
              ? 'text-primary'
              : 'text-muted hover:text-highlighted'"
          >
            <UIcon v-if="link.icon" :name="link.icon" class="size-4 shrink-0" />
            {{ link.label }}
          </NuxtLink>
        </nav>
      </UContainer>
    </div>
  </div>
</template>
