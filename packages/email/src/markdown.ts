import { renderMarkdownTemplate } from "@vite-hub/markdown-template"
import { renderHtml } from "@comark/html"

import type { RenderMarkdownTemplateOptions } from "@vite-hub/markdown-template"

export type RenderEmailMarkdownOptions = RenderMarkdownTemplateOptions

export interface RenderedEmailMarkdown {
  html: string
  text: string
}

export async function renderEmailMarkdown(
  template: string,
  options: RenderEmailMarkdownOptions = {},
): Promise<RenderedEmailMarkdown> {
  const markdown = await renderMarkdownTemplate(template, options)
  return {
    html: await renderHtml(markdown),
    text: markdown,
  }
}
