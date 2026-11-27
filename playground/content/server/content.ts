import { defineContent, image, optional, seo } from "vite-hub/content"
import { documents, singleton } from "vite-hub/content/collections"
import { cmsContentAuthorize } from "vite-hub/cms/access"
import { z } from "zod"

const link = z.object({ label: z.string().min(1), to: z.string().min(1), icon: z.string().optional() })

export default defineContent({
  workspace: "site",
  collections: {
    settings: singleton({
      path: "settings.json",
      fields: {
        title: z.string().min(1, "Add a site title."),
        description: z.string().max(160, "Keep the description under 160 characters.").optional(),
        socialImage: optional(image()),
        social: z.array(z.url()).default([]),
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
      components: {
        alert: { description: "A highlighted note", props: { type: { type: "string", default: "info" } } },
        "field-note": { description: "A note with an icon", props: { title: { type: "string" }, icon: { type: "image" } } },
        badge: { kind: "inline", description: "A short inline label" },
      },
    }),
    docs: documents({
      path: "docs/{locale}/**/*.md",
      locales: ["en", "es"],
      url: "/docs/:id",
      fields: {
        title: z.string().min(1, "Add a title."),
        description: z.string().max(160, "Keep the description under 160 characters.").optional(),
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
  seo: { sitemap: true, robots: { disallow: ["/_vitehub", "/login"] }, llms: { title: "Content playground" } },
  authorize: cmsContentAuthorize,
})
