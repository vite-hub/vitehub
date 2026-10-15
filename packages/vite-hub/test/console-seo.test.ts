import { describe, expect, it } from "vitest"

import { consoleImageUrl, consoleSeoFallbacks, consoleSeoField, consoleTruncate } from "../src/console/runtime/client/documents.ts"
import { describeConsoleSchemaFields } from "../src/console/runtime/client/schema-form.ts"

// The schema Content builds for a posts collection with `seo: seo({ image: image() })`.
const posts = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    seo: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        image: { type: "object", properties: { pathname: { type: "string" } }, required: ["pathname"], "x-vitehub-blob": { kind: "image", store: "default" } },
        canonical: { type: "string", format: "uri-reference" },
        noindex: { type: "boolean" },
      },
      additionalProperties: false,
      "x-vitehub-seo": { title: { recommended: 60 }, description: { min: 50, recommended: 160 } },
    },
  },
  required: ["title"],
}

describe("Console SEO panel model", () => {
  it("finds the seo() field by its hint", () => {
    expect(consoleSeoField(posts)).toMatchObject({ name: "seo", hint: { title: { recommended: 60 }, description: { min: 50, recommended: 160 } } })
    expect(consoleSeoField({ type: "object", properties: { title: { type: "string" } } })).toBeUndefined()
    expect(describeConsoleSchemaFields(consoleSeoField(posts)!.schema).find(field => field.name === "image")?.kind).toBe("blob")
  })

  it("shows what contentHead() falls back to", () => {
    expect(consoleSeoFallbacks({ title: "Hello", summary: "A first post." }, "title", "/blog/hello")).toEqual({ title: "Hello", description: "A first post.", url: "/blog/hello" })
    expect(consoleSeoFallbacks({ name: " ", excerpt: "Short." }, undefined, null)).toEqual({ description: "Short." })
  })

  it("previews images and long text as search results show them", () => {
    expect(consoleImageUrl("https://cdn.test/og.png")).toBe("https://cdn.test/og.png")
    // A Blob reference has no URL of its own; the media library resolves it with the served route of the project.
    expect(consoleImageUrl({ pathname: "og/hello world.png" })).toBeUndefined()
    expect(consoleImageUrl({})).toBeUndefined()
    expect(consoleTruncate("Hello, Content: documents, drafts, and publishing", 30)).toBe("Hello, Content: documents,…")
    expect(consoleTruncate("Short", 30)).toBe("Short")
  })
})
