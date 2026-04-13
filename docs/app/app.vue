<script setup lang="ts">
import { provide, shallowRef } from "vue";
import { useAppConfig, useHead, useSeoMeta } from "#imports";

const appConfig = useAppConfig();
const seo = appConfig.seo as { title?: string; description?: string; titleTemplate?: string; siteName?: string } | undefined;

const lang = "en";
const dir = "ltr" as const;
const navigation = shallowRef([]);

useHead({
  titleTemplate: title => !title || title === "ViteHub" ? "ViteHub" : `${title} · ViteHub`,
  meta: [
    { name: "viewport", content: "width=device-width, initial-scale=1" },
  ],
  link: [
    { rel: "icon", href: "/favicon.svg" },
  ],
  htmlAttrs: {
    lang,
    dir,
  },
});

useSeoMeta({
  titleTemplate: seo?.titleTemplate,
  title: seo?.title,
  description: seo?.description,
  ogSiteName: seo?.siteName || "ViteHub",
  twitterCard: "summary_large_image",
});

provide("navigation", navigation);
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
