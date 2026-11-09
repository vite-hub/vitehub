import { defineNuxtRouteMiddleware, isDocsStartLink, useDocsConfig } from "#imports"
import manifest from "#docs/manifest"
import { docsSectionForPath, findDocsPage } from "#docs/navigation"

// A docs page renders in the docs shell whichever app page serves its path. A page outside the docs base, such as
// `/about`, is a plain article under the site header, and a `home` page is its own blocks under it. A page that
// `start.links` lists opens inside the start section, so it gets the shell too.
export default defineNuxtRouteMiddleware((to) => {
  const found = findDocsPage(manifest, to.path)
  if (found) to.meta.layout = found.page.layout !== "home" && (found.section || found.page.path === manifest.root?.path || isDocsStartLink(useDocsConfig(), to.path)) ? "docs" : "default"
  // A new page that exists only as a Content draft renders in the shell of its section.
  else if (docsSectionForPath(manifest, to.path)) to.meta.layout = "docs"
})
