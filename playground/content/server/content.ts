import { defineContent, documents } from "vite-hub/content"
import { z } from "zod"

import { roleOf } from "./roles"

export const content = defineContent({
  workspace: "site",
  collections: {
    posts: documents({
      path: "posts/**/*.md",
      fields: {
        title: z.string().min(1, "Add a title."),
        date: z.coerce.date(),
        category: z.enum(["guide", "release", "story"]).default("story"),
        tags: z.array(z.string()).default([]),
        featured: z.boolean().default(false),
        summary: z.string().max(280, "Keep the summary under 280 characters.").optional(),
        author: z.object({ name: z.string().min(1), url: z.url().optional() }).optional(),
        readingTime: z.number().int().min(1).optional(),
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
  // Admins and editors do everything. Writers save drafts but cannot publish.
  authorize: ({ user, action }) => {
    const role = roleOf(user)
    if (role === "admin" || role === "editor") return true
    if (role === "writer") return action !== "publish"
    return false
  },
})
