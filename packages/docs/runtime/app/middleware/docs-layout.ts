import { defineNuxtRouteMiddleware } from "#imports"
import manifest from "#docs/manifest"
import { docsSectionForPath, findDocsPage } from "#docs/navigation"
import { ownsApp } from "#docs/shell"

// A docs page renders in the docs shell whichever app page serves its path. A page outside the docs base, such as
// `/about`, is a plain article under the site header, and a `home` page is its own blocks under it. In an app with its
// own `app.vue`, plain articles use their own layout, so the app's `default` layout stays on the app's pages.
export default defineNuxtRouteMiddleware((to) => {
  const found = findDocsPage(manifest, to.path)
  if (found) to.meta.layout = found.page.layout !== "home" && (found.section || found.page.path === manifest.root?.path) ? "docs" : ownsApp ? "default" : "docs-article"
  // A new page that exists only as a Content draft renders in the shell of its section.
  else if (docsSectionForPath(manifest, to.path)) to.meta.layout = "docs"
})
