import { parseMarkdown } from "comark"
import binding, { Binding } from "comark/plugins/binding"

import type { ComarkElement } from "./ast.ts"
import type { NodeHandler } from "comark/render"

export interface MarkdownTemplateRuntime {
  components: Record<string, NodeHandler>
  rawTag: string
}

export function createMarkdownTemplateRuntime(nonce: string): MarkdownTemplateRuntime {
  const rawTag = `markdown-template-raw-${nonce}`
  return {
    components: {
      Binding,
      [rawTag]: (node: ComarkElement) => typeof node[1].value === "string" ? node[1].value : "",
    },
    rawTag,
  }
}

export async function parseTemplateMarkdown(template: string, bindings = false) {
  return await parseMarkdown(template, {
    autoClose: false,
    autoUnwrap: false,
    linkify: false,
    plugins: bindings ? [binding()] : [],
  })
}

export function cleanMarkdown(markdown: string): string {
  return markdown.trim()
}

export function rawMarkdownNode(value: string, runtime: MarkdownTemplateRuntime): ComarkElement {
  return [runtime.rawTag, { value }]
}
