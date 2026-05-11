import { resolve } from "node:path";
import { defineCollection, defineContentConfig, z } from "@nuxt/content";
import { writeDocsArtifacts } from "./modules/vitehub-docs/artifacts";

const docsRoot = import.meta.dirname;
const repoRoot = resolve(docsRoot, "..");
const outputDir = resolve(docsRoot, ".generated");

const docsSchema = z.object({
  authors: z.array(z.object({
    avatar: z.object({
      src: z.string(),
    }).optional(),
    name: z.string(),
    to: z.string().optional(),
  })).optional(),
  date: z.string().optional(),
  image: z.string().optional(),
  links: z.array(z.object({
    label: z.string(),
    icon: z.string(),
    to: z.string(),
    target: z.string().optional(),
  })).optional(),
});

// Nuxt Content reads collections at config parse time, before the module setup runs.
writeDocsArtifacts({ docsRoot, repoRoot, outputDir });

export default defineContentConfig({
  collections: {
    docs: defineCollection({
      type: "page",
      source: {
        cwd: resolve(import.meta.dirname, ".generated/docs-content"),
        include: "**/*.md",
        prefix: "/docs",
      },
      schema: docsSchema,
    }),
  },
});
