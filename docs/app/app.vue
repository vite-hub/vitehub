<script setup lang="ts">
import { useAppConfig, useHead, useSeoMeta } from "#imports";

const appConfig = useAppConfig();
const seo = appConfig.seo as { title?: string; description?: string; siteName?: string } | undefined;

useHead({
  titleTemplate: title => !title || title === "ViteHub" ? "ViteHub" : `${title} · ViteHub`,
  meta: [
    { name: "viewport", content: "width=device-width, initial-scale=1" },
  ],
  link: [
    { rel: "icon", href: "/favicon.svg" },
  ],
  htmlAttrs: {
    lang: "en",
    dir: "ltr",
  },
});

useSeoMeta({
  title: seo?.title,
  description: seo?.description,
  ogSiteName: seo?.siteName || "ViteHub",
  twitterCard: "summary_large_image",
});
</script>

<template>
  <UApp>
    <NuxtLoadingIndicator color="var(--ui-primary)" />

    <div>
      <AppHeader />
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </div>
  </UApp>
</template>
