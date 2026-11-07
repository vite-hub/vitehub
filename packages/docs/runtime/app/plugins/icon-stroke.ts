import { defineNuxtPlugin, useAppConfig, useDocsConfig } from "#imports"

/**
 * Draws a 2px line icon with `stroke` instead. @nuxt/icon passes only the icon body in its CSS mode, so the icon is
 * recognized by its body: Lucide draws `stroke-width="2"` with round joins. Filled icons, such as brand logos, have no
 * stroke and stay as they are.
 */
export function docsIconStroke(body: string, stroke: number): string {
  if (!body.includes('stroke-linejoin="round"')) return body
  return body.replaceAll('stroke-width="2"', `stroke-width="${stroke}"`)
}

// Lucide draws its lines 2px wide. The docs draw them at `docs.icons.stroke`, 1.5px by default, the stroke of the
// ViteHub set, so a section icon and the page icons under it look like one set. A site that sets `icon.customize` in
// its app config keeps its own.
export default defineNuxtPlugin(() => {
  const icon = useAppConfig().icon
  const { stroke } = useDocsConfig().icons
  if (!icon || icon.customize || stroke === false) return
  icon.customize = (content: string) => docsIconStroke(content, stroke)
})
