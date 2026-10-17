import { image } from "vite-hub/blob"
import { defineContent, documents, optional, seo, singleton } from "vite-hub/content"
import { z } from "zod"

import { roleOf } from "./roles"

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
  // Admins and editors do everything. Writers save drafts but cannot publish.
  authorize: ({ user, action }) => {
    const role = roleOf(user)
    if (role === "admin" || role === "editor") return true
    if (role === "writer") return action !== "publish"
    return false
  },
})
