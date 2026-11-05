import { docsPageIcon, docsRailIcon, docsSectionIcon } from "#docs/navigation"
import { useDocsConfig } from "./docs"

import type { DocsPage, DocsSection } from "@vite-hub/docs"

/** Icons of pages and sections in the rail, the sidebar, and the catalog, after the `icons` options apply. */
export function useDocsIcons() {
  const { icons } = useDocsConfig()
  return {
    page: (page: Pick<DocsPage, "path" | "icon">) => docsPageIcon(icons, page),
    section: (section: Pick<DocsSection, "id" | "icon">) => docsSectionIcon(icons, section),
    rail: (section: Pick<DocsSection, "id" | "icon">) => docsRailIcon(icons, section),
  }
}
