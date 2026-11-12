import { defineContent, image, optional, seo } from "vite-hub/content"
import { documents, singleton } from "vite-hub/content/collections"
import { cmsContentAuthorize } from "vite-hub/cms/access"
import { z } from "zod"

const link = z.object({ label: z.string().min(1), to: z.string().min(1), icon: z.string().optional() })

export default defineContent({
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
        // An image prop opens the Media picker and stores the served URL, such as icon="/api/_vitehub/blob/train.webp".
        "field-note": { description: "A note with an icon", props: { title: { type: "string" }, icon: { type: "image" } } },
        badge: { kind: "inline", description: "A short inline label" },
      },
    }),
    // One document in two languages. `guide` is docs/en/guide.md in English, the source locale, and docs/es/guide.md
    // in Spanish. Spanish URLs start with /es. server/routes/[...path].get.ts renders both.
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
  // /sitemap.xml lists published posts and docs pages with their URL; /robots.txt points crawlers at it. `llms` serves
  // /llms.txt, /llms-full.txt, and /sitemap.md, and each page as Markdown at its URL plus `.md`.
  seo: { sitemap: true, robots: { disallow: ["/_vitehub", "/login"] }, llms: { title: "Content playground" } },
  // The CMS roles decide. This app keeps its own `site` Workspace instead of `extends: cms`, so it names the policy.
  // Publishers and admins publish, editors save drafts, and commenters read them.
  authorize: cmsContentAuthorize,
})
