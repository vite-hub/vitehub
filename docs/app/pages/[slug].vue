<script setup lang="ts">
import { createError } from "#app/composables/error";
import { useRoute } from "#app/composables/router";

const route = useRoute();
const pagePath = `/${String(route.params.slug)}`;

const { data: page } = await useAsyncData(
  `trust:${pagePath}`,
  () => queryCollection("trust").path(pagePath).first(),
);

if (!page.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

useSeoMeta({
  title: page.value.title,
  ogTitle: `${page.value.title} · ViteHub`,
  description: page.value.description,
  ogDescription: page.value.description,
});

useHead({
  link: [
    { rel: "canonical", href: `https://vitehub.dev${pagePath}` },
  ],
});
</script>

<template>
  <main v-if="page" class="mx-auto w-full max-w-3xl px-4 pb-24 pt-14 sm:px-6 sm:pt-20 lg:px-8 lg:pt-24">
    <UPageHeader
      :title="page.title"
      :description="page.description"
      :ui="{
        root: 'border-b border-default px-0 pb-10 pt-0',
        title: 'text-balance text-[38px] leading-[46px] sm:text-[46px] sm:leading-[54px]',
        description: 'max-w-2xl text-pretty text-lg leading-8',
      }"
    />

    <UPageBody prose class="trust-content !max-w-none !px-0 !pb-0 pt-10">
      <ContentRenderer :value="page" />
    </UPageBody>
  </main>
</template>

<style scoped>
.trust-content :deep(h1:first-of-type) {
  display: none;
}
</style>
