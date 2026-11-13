import { docsCollection } from "@vite-hub/docs"
import cms from "vite-hub/cms"
import { defineContent, documents, image, optional } from "vite-hub/content"
import { z } from "zod"

// The Console edits four collections. `docs` is the pages in content/, which the site renders from the repository at
// build time. `blog`, `changelog`, and `authors` exist only in the CMS: the site reads their published documents when a
// page is requested, so a publish in the Console is live on the next request. The files in blog/, changelog/, and
// authors/ of this repository are the seed that scripts/seed-content.mjs saves and publishes.
//
// Today the CMS keeps drafts and published documents in R2 and D1 (the Blob + Database store), because the GitHub token
// for vite-hub/vitehub does not exist yet. Its history and editor sessions are in the `content` Database.
//
// With the token, change the options to `{ repo: "vite-hub/vitehub", root: "packages/docs/playground", publish: "commit", access: "roles", database:
// "content" }`: a save then commits to the `vitehub/content` branch, and a publish commits to `main`.
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "Use a version such as 1.4.0.")

export default defineContent({
  extends: [cms, { access: "roles", database: "content" }],
  collections: {
    docs: docsCollection(),
    blog: documents({
      path: "blog/*.md",
      url: "/blog/:id",
      label: { singular: "Post", plural: "Blog" },
      fields: {
        title: z.string().min(1, "Add a title."),
        description: z.string().min(1).max(200, "Keep the description under 200 characters."),
        date: z.coerce.date(),
        // Ids of documents in `authors`, such as `ada`.
        authors: z.array(z.string()).min(1, "Add an author."),
        tags: z.array(z.string()).default([]),
        // An illustration from the media library, shown at the top of the post.
        cover: optional(image({ store: "media" })),
      },
    }),
    changelog: documents({
      path: "changelog/*.md",
      url: "/changelog/:id",
      label: { singular: "Release", plural: "Changelog" },
      titleField: "title",
      fields: {
        version: semver,
        title: z.string().min(1, "Add a one-line summary of the release."),
        date: z.coerce.date(),
        // Releases that need a change in `lumen.config.ts` or in a script.
        breaking: z.boolean().default(false),
      },
    }),
    authors: documents({
      path: "authors/*.yaml",
      label: { singular: "Author", plural: "Authors" },
      fields: {
        name: z.string().min(1),
        role: z.string().min(1),
        bio: z.string().max(280, "Keep the bio under 280 characters."),
        github: z.string().regex(/^[\w-]+$/, "Use the GitHub login, without @.").optional(),
      },
    }),
  },
})
