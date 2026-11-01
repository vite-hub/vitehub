import { defineContent, documents, image, optional, seo, singleton } from "vite-hub/content"
import { cmsContentAuthorize } from "vite-hub/cms/access"
import { z } from "zod"

const link = z.object({ label: z.string().min(1), to: z.string().min(1), icon: z.string().optional() })

export const content = defineContent({
  workspace: "site",
  collections: {
    // One document for the whole site. The fields are this site's choice; ViteHub has no fixed settings schema.
    settings: singleton({
      path: "settings.json",
      fields: {
        title: z.string().min(1, "Add a site title."),
        description: z.string().max(160, "Keep the description under 160 characters.").optional(),
        socialImage: optional(image()),
        social: z.array(z.url()).default([]),
        // Structured site data, as a marketing site keeps it: an image by URL, a menu, and grouped footer links.
        logo: z.object({ src: z.string(), alt: z.string() }).optional(),
        navigation: z.array(link.extend({ menu: z.enum(["product", "company"]).optional() })).default([]),
        footer: z.array(z.object({ title: z.string().min(1), links: z.array(link) })).default([]),
      },
    }),
    posts: documents({
      path: "posts/**/*.md",
      url: "/blog/:id",
      fields: {
        title: z.string().min(1, "Add a title."),
        date: z.coerce.date(),
        category: z.enum(["guide", "release", "story"]).default("story"),
        tags: z.array(z.string()).default([]),
        featured: z.boolean().default(false),
        summary: z.string().max(280, "Keep the summary under 280 characters.").optional(),
        author: z.object({ name: z.string().min(1), url: z.url().optional() }).optional(),
        readingTime: z.number().int().min(1).optional(),
        seo: seo({ image: image() }),
      },
      // The Console offers these in the body's `/` menu. The site renders them with its own Vue components.
      components: {
        alert: { description: "A highlighted note", props: { type: { type: "string", default: "info" } } },
        badge: { kind: "inline", description: "A short inline label" },
      },
    }),
    pages: documents({
      path: "pages/**/*.md",
      fields: {
        title: z.string().min(1),
        navigation: z.boolean().default(true),
      },
    }),
  },
  // /sitemap.xml lists published posts with their URL; /robots.txt points crawlers at it.
  seo: { sitemap: true, robots: { disallow: ["/_vitehub", "/login"] } },
  // The CMS roles decide. This app keeps its own `site` Workspace instead of `extends: cms`, so it names the policy.
  // Publishers and admins publish, editors save drafts, and commenters read them.
  authorize: cmsContentAuthorize,
})
