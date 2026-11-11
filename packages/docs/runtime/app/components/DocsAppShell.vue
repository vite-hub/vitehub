<script setup lang="ts">
import { docsAppPath, normalizeDocsPath } from "#docs/navigation"
import { ownsApp } from "#docs/shell"
import design from "#docs/theme"

import { resolveDocsTheme } from "../utils/docs-theme"

const props = defineProps<{
  /** Set by the docs layouts. They draw the shell only in an app with its own `app.vue`, where the docs `app.vue` does not. */
  layout?: boolean
}>()

const active = !props.layout || !ownsApp
const route = useRoute()
const words = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `
const { site, appBase } = useDocsConfig()
const appConfig = useAppConfig()
const theme = computed(() => resolveDocsTheme(design, appConfig.ui))

if (active) {
  useHead({
    // One title pattern for every page: "KV configuration · ViteHub". A title that already names the site stays as written.
    // The check ignores case and punctuation, so "Comark UI" counts as naming `comark-ui`.
    titleTemplate: title => !title ? site.name : words(title).includes(words(site.name)) ? title : `${title} · ${site.name}`,
    // One canonical URL per page: the configured origin, no trailing slash, and no query.
    link: site.url ? [{ rel: "canonical", href: () => `${site.url}${docsAppPath(normalizeDocsPath(route.path), appBase).replace(/\/+$/, "")}` }] : [],
    // In an app with its own `app.vue`, the app's head stays on its pages, and the docs pages add what they need.
    meta: ownsApp ? [] : [{ name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" }],
    // The theme's CSS applies below `.vh-docs`. A docs site sets it on every page in its head config.
    htmlAttrs: ownsApp ? {} : { class: "vh-docs" },
  })

  useSeoMeta({
    ogSiteName: site.name,
    twitterCard: "summary_large_image",
    robots: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
  })
}
</script>

<template>
  <!-- In an app with its own `app.vue`, the theme reaches the docs pages through `<UTheme>`. Its maps are empty in a docs site. -->
  <UTheme v-if="active" :ui="theme.ui" :props="theme.props">
    <div class="flex">
      <div class="min-w-0 flex-1">
        <AppHeader v-if="$route.meta.header !== false" />
        <slot />

        <ClientOnly>
          <AppSearch />
        </ClientOnly>
        <DocsAssistant />
      </div>
    </div>
  </UTheme>
  <slot v-else />
</template>
