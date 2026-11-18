import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { checkDocsLinks } from "../src/check-links.ts"
import { createDocsManifest } from "../src/manifest.ts"

it("stops on a broken link with DOCS_LINKS_BROKEN, its problems, and a fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "vitehub-docs-links-"))
  try {
    mkdirSync(join(dir, "docs"))
    writeFileSync(join(dir, "docs", "index.html"), "<html><body><h1>Docs</h1><a href=\"/docs/missing\">Missing</a></body></html>")
    expect(() => checkDocsLinks({ dir, siteUrl: "https://docs.test" })).toThrow(expect.objectContaining({
      code: "DOCS_LINKS_BROKEN",
      fix: expect.stringContaining("excludeLinks"),
      problems: [expect.stringContaining("/docs/missing")],
    }))
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

it("rejects invalid frontmatter with DOCS_CONTENT_INVALID and a fix that names the schemas", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vitehub-docs-content-"))
  try {
    mkdirSync(join(dir, "guide"))
    writeFileSync(join(dir, "guide", "install.md"), "---\nlayout: wide\n---\n# Install\n")
    await expect(createDocsManifest({ dir, base: "/docs" })).rejects.toMatchObject({
      code: "DOCS_CONTENT_INVALID",
      fix: expect.stringContaining("docsPageSchema"),
      message: expect.stringContaining("Invalid docs frontmatter in"),
    })
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
