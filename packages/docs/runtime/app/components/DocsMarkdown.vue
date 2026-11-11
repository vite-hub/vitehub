<script setup lang="ts">
import { MarkdownDocument } from "@comark/vue"
import comarkUi from "comark-ui/vue"
import { camelize, capitalize, defineAsyncComponent } from "vue"
import customComponents from "#docs/custom-components"
import contentComponents from "#docs/components"

import type { Component } from "vue"
import type { ElementNode, Node as ComarkNode } from "comark"
import type { DocsDocument } from "@vite-hub/docs"

// The server parsed the page, so the client only renders nodes. Explicit maps and app content components override
// comark-ui's blocks. Content components still load on first use.
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

const contentBlocks = Object.fromEntries(Object.entries(contentComponents).flatMap(([tag, load]) => load ? [[tag, defineAsyncComponent(async () => (await load()).default)]] : []))
const componentKey = (tag: string) => capitalize(camelize(tag))
const resolved = computed(() => {
  const components: Record<string, Component> = {}
  for (const map of [blocks, callouts, contentBlocks, customComponents, props.components ?? {}]) {
    // Comark looks up PascalCase before the raw tag, so all maps must use the same keys for precedence to hold.
    for (const [tag, component] of Object.entries(map)) components[componentKey(tag)] = component
  }
  return components
})

// HTML is the fallback. An app component still receives the original tag, props, and source children.
function renderNodes(nodes: ComarkNode[]): ComarkNode[] {
  return nodes.map((node): ComarkNode => {
    if (typeof node === "string" || node[0] === null) return node
    const [tag, attributes, ...children] = node
    const { block, blockProps } = attributes
    if (tag === "comark-html" && typeof block === "string" && resolved.value[componentKey(block)]) {
      return [block, (blockProps ?? {}) as ElementNode[1], ...renderNodes(children)]
    }
    return [tag, attributes, ...renderNodes(children)]
  })
}
const nodes = computed(() => renderNodes(props.document.nodes))
</script>

<template>
  <MarkdownDocument
    :value="{ nodes, frontmatter: {}, meta: {} }"
    :components="resolved"
  />
</template>
