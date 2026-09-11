import { describe, expect, it } from "vitest"

import { defineContent, defineContentHandler } from "../src/index.ts"
import type { ContentSource } from "comark-content"

function source(files: Record<string, string>): ContentSource {
  return {
    async keys() { return Object.keys(files) },
    async getItem(key) { return files[key] },
    async getItemRaw(key) { return files[key] },
  }
}

describe("defineContent", () => {
  it("creates a named Comark content instance", async () => {
    const content = defineContent({ source: source({ "index.md": "# Hello" }) })
    await expect(content.get("/")).resolves.toEqual(expect.objectContaining({ path: "/" }))
  })

  it("composes named sources through Comark's hub", async () => {
    const content = defineContent({
      sources: {
        docs: source({ "index.md": "# Docs" }),
        blog: source({ "post.md": "# Post" }),
      },
    })
    await expect(content.get("docs/index.md")).resolves.toEqual(expect.objectContaining({ path: "/" }))
    await expect(content.get("blog/post.md")).resolves.toEqual(expect.objectContaining({ path: "/post" }))
  })
})

describe("defineContentHandler", () => {
  it("adapts H3 events to the Comark handler", async () => {
    const content = defineContent({ source: source({ "index.md": "# Hello" }) })
    const handler = defineContentHandler(content)
    const response = await handler.fetch("https://example.test/api/content/get/")
    expect(response.status).toBe(200)
  })
})
