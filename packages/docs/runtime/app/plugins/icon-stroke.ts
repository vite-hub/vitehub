import { defineNuxtPlugin, useAppConfig } from "#imports"

// Lucide draws its lines 2px wide. The docs draw every Lucide icon at 1.5px, the stroke of the ViteHub set, so a
// section icon and the page icons under it look like one set. A site that sets `icon.customize` in its app config
// keeps its own.
export default defineNuxtPlugin(() => {
  const icon = useAppConfig().icon
  if (!icon || icon.customize) return
  icon.customize = (content: string, _name?: string, prefix?: string) =>
    prefix === "lucide" ? content.replaceAll('stroke-width="2"', 'stroke-width="1.5"') : content
})
