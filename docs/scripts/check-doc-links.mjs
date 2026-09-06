#!/usr/bin/env node
import { resolve } from "node:path";
import { docsManifest } from "../.generated/docs-manifest.mjs";
import { docsManifestRoutes, validateDocumentationLinks } from "./markdown-links.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsRoutes = docsManifestRoutes(docsManifest);
const result = validateDocumentationLinks({ docsRoutes, repoRoot });

if (result.errors.length > 0) {
  console.error(`Documentation link validation failed with ${result.errors.length} error(s):`);
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${result.checked} internal links across ${result.files} documentation files.`);
}
