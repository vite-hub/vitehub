import { defineNuxtRouteMiddleware } from "#imports"
import manifest from "#docs/manifest"
import { findDocsPage } from "#docs/navigation"

// A docs page renders in the docs shell whichever app page serves its path. A page outside the docs base, such as
// `/about`, is a plain article under the site header.
export default defineNuxtRouteMiddleware((to) => {
  const found = findDocsPage(manifest, to.path)
  if (found) to.meta.layout = found.section || found.page.path === manifest.root?.path ? "docs" : "default"
})
