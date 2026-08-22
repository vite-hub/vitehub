<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{
  error: NuxtError;
}>();

const isNotFound = computed(() => props.error.statusCode === 404);
const title = computed(() => isNotFound.value ? "ViteHub page not found" : "ViteHub could not load this page");
const description = computed(() => isNotFound.value
  ? "The requested path does not match a published ViteHub page. Use one of the indexes below to recover."
  : "The page failed before ViteHub could render it. Return to the documentation index and try a published route.");

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

        <nav class="mt-8 flex flex-wrap gap-x-6 gap-y-3" aria-label="Recovery links">
          <NuxtLink class="font-medium text-highlighted underline underline-offset-4" to="/docs">
            Documentation index
          </NuxtLink>
          <NuxtLink class="font-medium text-highlighted underline underline-offset-4" to="/llms.txt">
            llms.txt
          </NuxtLink>
          <NuxtLink class="font-medium text-highlighted underline underline-offset-4" to="/sitemap.xml">
            Sitemap
          </NuxtLink>
        </nav>
      </section>
    </main>

    <AppFooter />
  </UApp>
</template>
