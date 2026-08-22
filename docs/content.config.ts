import { resolve } from "node:path";
import { defineCollection, defineContentConfig, z } from "@nuxt/content";
import { writeDocsArtifacts } from "./modules/vitehub-docs/artifacts";

const docsRoot = import.meta.dirname;
const outputDir = resolve(docsRoot, ".generated");

const pageSchema = z.object({
  authors: z.array(z.object({
    avatar: z.object({
      src: z.string(),
    }).optional(),
    description: z.string().optional(),
    name: z.string(),
    target: z.string().optional(),
    to: z.string().optional(),
  })).optional(),
  category: z.string().optional(),
  date: z.string().optional(),
  featured: z.boolean().optional(),
  icon: z.string().optional(),
  image: z.string().optional(),
  links: z.array(z.object({
    label: z.string(),
    icon: z.string(),
    to: z.string(),
    target: z.string().optional(),
  })).optional(),
});

const blogSchema = pageSchema.extend({
  layout: z.enum(["article", "tutorial"]).optional(),
});

// Nuxt Content reads collections at config parse time, before the module setup runs.
writeDocsArtifacts({ docsRoot, outputDir });

export default defineContentConfig({
  collections: {
    docs: defineCollection({
      type: "page",
      source: {
        cwd: resolve(import.meta.dirname, "content/docs"),
        include: "**/*.{md,yml,yaml}",
        prefix: "/docs",
      },
      schema: pageSchema,
    }),
    blog: defineCollection({
      type: "page",
      source: {
        cwd: resolve(import.meta.dirname, "content/blog"),
        include: "**/*.md",
        prefix: "/blog",
      },
      schema: blogSchema,
    }),
    trust: defineCollection({
      type: "page",
      source: {
        cwd: resolve(import.meta.dirname, "content/trust"),
        include: "**/*.md",
        prefix: "/",
      },
      schema: pageSchema,
    }),
  },
});
