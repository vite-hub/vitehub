<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{
  error: NuxtError;
}>();

const isNotFound = computed(() => props.error.statusCode === 404);
const title = computed(() => isNotFound.value ? "Page not found" : "This page failed to load");
const description = computed(() => isNotFound.value
  ? "The page may have moved or been renamed. Search the docs, or open one of these sections."
  : "Reload the page to try again. If it still fails, search the docs or open one of these sections.");

const sections = [
  { label: "Docs", to: "/docs" },
  { label: "Get started", to: "/docs/getting-started" },
  { label: "Tutorials", to: "/tutorials" },
  { label: "Projects", to: "/projects" },
  { label: "Templates", to: "/templates" },
];

// The error page replaces the app shell, so it mounts the search dialog that the header button and Ctrl K open.
const { open: openSearch } = useContentSearch();

useSeoMeta({
  title,
  description,
  robots: "noindex, nofollow",
});
</script>

<template>
  <UApp>
    <AppHeader />

    <main class="mx-auto flex min-h-[calc(100svh-var(--ui-header-height))] w-full max-w-3xl items-center px-4 py-16 sm:px-6 lg:px-8">
      <section class="w-full border-y border-default py-12 sm:py-16">
        <p class="font-mono text-sm text-muted">
          HTTP {{ error.statusCode }}
        </p>
        <h1 class="mt-4 max-w-2xl text-balance text-4xl font-semibold tracking-[-0.04em] text-highlighted sm:text-5xl">
          {{ title }}
        </h1>
        <p class="mt-6 max-w-2xl text-pretty text-lg/8 text-muted">
          {{ description }}
        </p>

        <UButton
          class="mt-8"
          icon="i-lucide-search"
          label="Search the docs"
          color="neutral"
          variant="outline"
          @click="openSearch = true"
        />

        <nav class="mt-8 flex flex-wrap gap-x-6 gap-y-3" aria-label="Sections">
          <NuxtLink
            v-for="section in sections"
            :key="section.to"
            class="font-medium text-highlighted underline underline-offset-4"
            :to="section.to"
          >
            {{ section.label }}
          </NuxtLink>
        </nav>

        <p class="mt-10 text-sm text-muted">
          For coding agents:
          <NuxtLink class="underline underline-offset-4 hover:text-highlighted" to="/llms.txt" external>llms.txt</NuxtLink>
          and the
          <NuxtLink class="underline underline-offset-4 hover:text-highlighted" to="/sitemap.xml" external>Sitemap</NuxtLink>.
        </p>
      </section>
    </main>

    <ClientOnly>
      <AppSearch />
    </ClientOnly>
  </UApp>
</template>
