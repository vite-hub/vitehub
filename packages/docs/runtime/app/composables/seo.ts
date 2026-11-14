import { defineArticle, defineBreadcrumb, defineOgImage, defineWebPage, defineWebSite, useRoute, useSchemaOrg, useSeoMeta } from "#imports"
import { docsAppPath, normalizeDocsPath } from "#docs/navigation"

import { useDocsConfig } from "./docs"

export interface DocsSeoInput {
  title: string
  description?: string | null
  /** Section label in the share image and the breadcrumb, such as `KV`. */
  section?: { title: string, path: string } | null
  /** A path in `public/` or a URL for the share image, or `false` for none. Without it the build renders one. */
  image?: string | false
  /** `article` marks the page a TechArticle in Schema.org. */
  type?: "article" | "page"
}

/**
 * Title, description, share image, and Schema.org of a page. Docs pages call it with their frontmatter; an app page,
 * such as a playground, calls it to look the same when shared.
 */
export function useDocsSeo(input: DocsSeoInput): void {
  const { site, appBase, ogImage } = useDocsConfig()
  const route = useRoute()
  const path = docsAppPath(normalizeDocsPath(route.path), appBase)
  // A section's own Overview names the section already.
  const section = input.section && input.section.path !== path ? input.section : null
  const description = input.description ?? site.description ?? undefined
  useSeoMeta({ title: input.title, ogTitle: input.title, description, ogDescription: description, ogType: input.type === "article" ? "article" : "website" })

  if (input.image === false) {
    // Null overrides inherited head tags before Unhead removes them from the rendered page.
    useSeoMeta({ ogImage: null, ogImageUrl: null, ogImageSecureUrl: null, ogImageType: null, ogImageWidth: null, ogImageHeight: null, ogImageAlt: null, twitterImage: null, twitterImageAlt: null })
  }
  else if (input.image) {
    const imagePath = input.image.startsWith("/") ? input.image : `/${input.image}`
    const image = /^https?:\/\//.test(input.image) ? input.image : `${site.url}${docsAppPath(imagePath, appBase)}`
    useSeoMeta({ ogImage: image, ogImageUrl: null, ogImageSecureUrl: null, ogImageType: null, ogImageWidth: null, ogImageHeight: null, ogImageAlt: null, twitterImage: image, twitterImageAlt: null })
  }
  else if (ogImage) {
    // SAFETY: `ogImage.component` is an OgImage component; the default ships with this package, and an app names its own.
    defineOgImage(ogImage.component as "DocsPage", {
      title: input.title,
      description: description ?? "",
      site: site.name,
      section: section?.title ?? "",
      // A path, so the prerender reads the file from the build instead of fetching the site before it is deployed.
      logo: site.logo ? site.logo.src : "",
      host: site.url.replace(/^https?:\/\//, ""),
    })
  }

  useSchemaOrg([
    defineWebSite({ name: site.name, description: site.description ?? undefined }),
    defineWebPage({ name: input.title, description }),
    ...input.type === "article" ? [defineArticle({ "@type": "TechArticle", "headline": input.title, description })] : [],
    ...section
      ? [defineBreadcrumb({ itemListElement: [{ name: site.name, item: docsAppPath("/", appBase) }, { name: section.title, item: section.path }, { name: input.title }] })]
      : [],
  ])
}
