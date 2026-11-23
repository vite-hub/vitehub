import { assertBindingRoot, resolveScalarTemplateBinding, snapshotTemplateData } from "./bindings.ts"

import type { NodeRenderData } from "comark/render"

export function mapTemplateTextBindings(text: string, map: (path: string) => string | void): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (binding, inner: string) => {
    const path = inner.trim()
    assertBindingRoot(path)
    return map(path) ?? binding
  })
}

/**
 * Fills each `{{ data.<path> }}` binding of plain text, such as an email subject, with the same rules as a template
 * body. The result is plain text, not Markdown. A filled value is not read again, so `{{ ... }}` in `data` stays text.
 */
export function fillTemplateText(text: string, data: Record<string, unknown> = {}): string {
  const renderData: NodeRenderData = { data: snapshotTemplateData(data), frontmatter: {}, meta: {}, props: {} }
  return mapTemplateTextBindings(text, path => resolveScalarTemplateBinding({ ":value": path }, renderData))
}
