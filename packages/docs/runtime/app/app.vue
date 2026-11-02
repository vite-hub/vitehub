<script setup lang="ts">
import { docsAppPath, normalizeDocsPath } from "#docs/navigation"

const route = useRoute()
const { site, appBase } = useDocsConfig()

useHead({
  // One title pattern for every page: "KV configuration · ViteHub". A title that already names the site stays as written.
  titleTemplate: title => !title ? site.name : title.includes(site.name) ? title : `${title} · ${site.name}`,
  // One canonical URL per page: the configured origin, no trailing slash, and no query.
  link: site.url ? [{ rel: "canonical", href: () => `${site.url}${docsAppPath(normalizeDocsPath(route.path), appBase).replace(/\/+$/, "")}` }] : [],
})

useSeoMeta({
  ogSiteName: site.name,
  twitterCard: "summary_large_image",
  robots: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
})
</script>

<template>
  <UApp>
    <NuxtLoadingIndicator color="var(--ui-primary)" />

    <div class="flex">
      <div class="min-w-0 flex-1">
        <AppHeader v-if="$route.meta.header !== false" />
        <NuxtLayout>
          <NuxtPage />
        </NuxtLayout>

        <ClientOnly>
          <AppSearch />
        </ClientOnly>
        <DocsAssistant />
      </div>
    </div>
  </UApp>
</template>
