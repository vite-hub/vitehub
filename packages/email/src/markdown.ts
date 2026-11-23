import { renderMarkdownTemplate } from "@vite-hub/markdown-template"
import { fillTemplateText } from "@vite-hub/markdown-template/internal/composition"
import { renderHtml } from "@comark/html"

import { parseEmailMarkdown } from "./frontmatter.ts"

import type { RenderMarkdownTemplateOptions } from "@vite-hub/markdown-template"
import type { RenderedEmail } from "./types.ts"

export type RenderEmailMarkdownOptions = RenderMarkdownTemplateOptions
export type { RenderedEmail }

/**
 * Renders a Markdown Email template once. `subject` comes from the `subject:` frontmatter, `text` is the filled
 * Markdown, and `html` is that Markdown rendered by Comark. Values in `data` are never read as template syntax.
 */
export async function renderEmailMarkdown(
  template: string,
  options: RenderEmailMarkdownOptions = {},
): Promise<RenderedEmail> {
  const { content, subject } = parseEmailMarkdown(template)
  const markdown = await renderMarkdownTemplate(content, options)
  const html = await renderHtml(markdown)
  return subject === undefined
    ? { html, text: markdown }
    : { subject: fillTemplateText(subject, options.data), html, text: markdown }
}
