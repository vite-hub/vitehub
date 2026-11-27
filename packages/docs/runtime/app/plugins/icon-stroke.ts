import { docsIconStroke } from "#docs/navigation"
import { defineNuxtPlugin, useAppConfig, useDocsConfig } from "#imports"

// Lucide draws its lines 2px wide. The docs draw them at `docs.icons.stroke`, 1.5px by default, the stroke of the
// ViteHub set, so a section icon and the page icons under it look like one set. A site that sets `icon.customize` in
// its app config keeps its own.
export default defineNuxtPlugin(() => {
  const icon = useAppConfig().icon
  const { stroke } = useDocsConfig().icons
  if (!icon || icon.customize || stroke === false) return
  icon.customize = (content: string) => docsIconStroke(content, stroke)
})
