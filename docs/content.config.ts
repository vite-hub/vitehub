import { resolve } from "node:path";
import { defineCollection, defineContentConfig } from "@nuxt/content";
import { writeDocsArtifacts } from "./modules/vitehub-docs/artifacts";

const docsRoot = import.meta.dirname;
const repoRoot = resolve(docsRoot, "..");
const outputDir = resolve(docsRoot, ".generated");

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
    }),
    landing: defineCollection({
      type: "page",
      source: "index.md",
    }),
    pages: defineCollection({
      type: "page",
      source: "*.md",
    }),
  },
});
