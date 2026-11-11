import { defineNuxtRouteMiddleware, isDocsStartLink, navigateTo, useDocsConfig, useRuntimeConfig } from "#imports"
import manifest from "#docs/manifest"
import { docsAppPath, docsSectionForPath, findDocsPage } from "#docs/navigation"
import { ownsApp } from "#docs/shell"

// A docs page renders in the docs shell whichever app page serves its path. A page outside the docs base, such as
// `/about`, is a plain article under the site header, and a `home` page is its own blocks under it. A page that
// `start.links` lists opens inside the start section, so it gets the shell too. With an app-owned `app.vue`, plain
// articles use `docs-article`, so the app keeps its `default` layout.
export default defineNuxtRouteMiddleware((to, from) => {
  const found = findDocsPage(manifest, to.path)
  if (found) to.meta.layout = found.page.layout !== "home" && (found.section || found.page.path === manifest.root?.path || isDocsStartLink(useDocsConfig(), to.path)) ? "docs" : ownsApp ? "default" : "docs-article"
  // A new page that exists only as a Content draft renders in the shell of its section.
  else if (docsSectionForPath(manifest, to.path)) to.meta.layout = "docs"
  // No docs page and no app page answers the path, but the host may: a static app copied into the output, such as a
  // playground at `/play/`, or a file in `public/`. A client navigation would draw the docs 404 for it, so the browser
  // loads it. The first load and a reload come from the server already, so they never reach this.
  else if (import.meta.client && from.matched.length > 0 && to.name === "docs-page" && to.path !== from.path)
    return navigateTo(docsAppPath(to.fullPath, useRuntimeConfig().app.baseURL), { external: true })
})
