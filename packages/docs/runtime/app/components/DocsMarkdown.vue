<script setup lang="ts">
import { MarkdownDocument } from "@comark/vue"
import comarkUi from "comark-ui/vue"
import customComponents from "#docs/custom-components"
import contentComponents from "#docs/components"

import type { Component } from "vue"
import type { DocsDocument } from "@vite-hub/docs"

// The server parsed the page, so the client only renders nodes. A tag resolves to `components`, then to comark-ui's
// blocks, then to a global component, then to a component in `components/content/`, loaded on first use.
const props = defineProps<{
  document: DocsDocument
  /** Components by tag, such as `{ pre: DocsCodePre }`. */
  components?: Record<string, Component>
}>()

// Every block's component, not only those of the plugins this package parses with: a site that adds chips or another
// comark-ui plugin to its parser gets its nodes drawn, and a component no node names costs nothing.
const { components: blocks } = comarkUi()

// `::note`, `::tip`, and the other callout components draw comark-ui's GitHub callout, the same as a `> [!NOTE]` quote.
const callout = (type: string, title?: string): Component => defineComponent({
  name: `${type[0]!.toUpperCase()}${type.slice(1)}Callout`,
  setup: (_, { slots }) => () => h(blocks.GithubCallout!, { type, title }, slots),
})
const callouts: Record<string, Component> = {
  Note: callout("note", "Note"),
  Tip: callout("tip", "Tip"),
  Important: callout("important", "Important"),
  Warning: callout("warning", "Warning"),
  Caution: callout("caution", "Caution"),
  Callout: callout("note"),
}

// Nuxt UI's global `ProseCodeTree` would draw `::code-tree` before the content components get a turn, so the package's
// own, drawn in this design, is named here. A site's `components` still replace it.
const own: Record<string, Component> = {
  CodeTree: defineAsyncComponent(() => import("./content/CodeTree.vue")),
}

const resolved = computed(() => ({ ...blocks, ...callouts, ...own, ...customComponents, ...props.components }))
const componentsManifest = (tag: string) => contentComponents[tag]?.()
</script>

<template>
  <MarkdownDocument
    :value="{ nodes: document.nodes, frontmatter: {}, meta: {} }"
    :components="resolved"
    :components-manifest="componentsManifest"
  />
</template>
