import { renderMarkdownTemplate } from "@vite-hub/markdown-template"
import { parseMarkdown } from "comark/parse"
import { render } from "comark/render"

import type { RenderMarkdownTemplateOptions } from "@vite-hub/markdown-template"

export type RenderEmailMarkdownOptions = RenderMarkdownTemplateOptions

export interface RenderedEmailMarkdown {
  html: string
  text: string
}

function removeFinalNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value
}

export async function renderEmailMarkdown(
  template: string,
  options: RenderEmailMarkdownOptions = {},
): Promise<RenderedEmailMarkdown> {
  const markdown = await renderMarkdownTemplate(template, options)
  const tree = await parseMarkdown(markdown)
  const html = await render(tree, { blockSeparator: "\n", format: "text/html" })
  return {
    html: removeFinalNewline(html),
    text: markdown,
  }
}
