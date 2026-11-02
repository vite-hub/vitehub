<script setup lang="ts">
import { MarkdownDocument } from "@comark/vue"
import contentComponents from "#docs/components"

import type { Component } from "vue"
import type { DocsDocument } from "@vite-hub/docs"

// The server parsed the page, so the client only renders nodes. A tag resolves to `components`, then to a global
// component such as Nuxt UI's `ProseNote`, then to a component in `components/content/`, loaded on first use.
defineProps<{
  document: DocsDocument
  /** Components by tag, such as `{ pre: DocsCodePre }`. */
  components?: Record<string, Component>
}>()

const componentsManifest = (tag: string) => contentComponents[tag]?.()
</script>

<template>
  <MarkdownDocument
    :value="{ nodes: document.nodes, frontmatter: {}, meta: {} }"
    :components="components ?? {}"
    :components-manifest="componentsManifest"
  />
</template>
