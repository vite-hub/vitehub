import { renderHtmlFromDocument } from "@comark/html"
import comarkUi from "comark-ui/html"
import type { MarkdownDocument, RendererOptions } from "comark"
import type { PresetOptions } from "comark-ui/html"

/** The Comark UI preset options that Content parses Markdown with. The Vue renderer omits the HTML-only `annotate`, `diff`, and `quiz` plugins, so they are off. */
export const contentMarkdownPreset: PresetOptions = { annotate: false, diff: false, quiz: false, chips: { download: false }, badge: { download: false } }

let presetComponents: RendererOptions["components"] | undefined

/**
 * Render a parsed Content document, such as one from `content.get()`, to HTML without a framework. It draws the
 * Comark UI components that Content parses, such as math formulas. `components` adds or replaces
 * renderers by tag.
 */
export async function renderContentHtml(document: { nodes: MarkdownDocument["nodes"] }, options: RendererOptions = {}): Promise<string> {
  presetComponents ??= comarkUi(contentMarkdownPreset).components
  return await renderHtmlFromDocument(document, { ...options, components: { ...presetComponents, ...options.components } })
}
