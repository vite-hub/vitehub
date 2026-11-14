import { describe, expect, it } from "vitest"

import { parseImageVariant } from "../src/media/variant.ts"
import blobImageProvider from "../src/nuxt-image.ts"

const { getImage } = blobImageProvider()

describe("Nuxt Image provider", () => {
  it("maps Nuxt Image modifiers to served Blob variant parameters", () => {
    // Nuxt Image adds a leading slash before it calls the provider.
    const { url } = getImage("/photos/cat.jpg", { modifiers: { fit: "cover", format: "avif", height: 300, quality: 60, width: 400 } })
    expect(url).toBe("/api/_vitehub/blob/photos/cat.jpg?w=640&h=384&fit=cover&fmt=avif&q=60")
    expect(parseImageVariant(new URL(url, "https://example.com").searchParams)).toEqual({ fit: "cover", format: "avif", height: 384, quality: 60, width: 640 })
  })

  it("snaps widths like the server, so near sizes share one cached URL", () => {
    const urls = [641, 700, 750].map(width => getImage("/a.png", { modifiers: { width } }).url)
    expect(new Set(urls)).toEqual(new Set(["/api/_vitehub/blob/a.png?w=750"]))
    expect(getImage("/a.png", { imageSizes: [320, 960], modifiers: { width: 400 } }).url).toBe("/api/_vitehub/blob/a.png?w=960")
    expect(getImage("/a.png", { modifiers: { width: 9000 } }).url).toBe("/api/_vitehub/blob/a.png?w=3840")
  })

  it("serves the original without modifiers and drops values the route does not support", () => {
    expect(getImage("/a.png", { modifiers: {} }).url).toBe("/api/_vitehub/blob/a.png")
    expect(getImage("/a.png", { modifiers: { fit: "fill", format: "gif", quality: 0 } }).url).toBe("/api/_vitehub/blob/a.png")
    expect(getImage("/a.png", { modifiers: { fit: "contain", format: "JPG", quality: 150 } }).url).toBe("/api/_vitehub/blob/a.png?fit=inside&fmt=jpeg&q=100")
  })

  it("passes a named crop of the media record", () => {
    expect(getImage("/posts/cover.jpg", { modifiers: { crop: "mobile", width: 640 } }).url).toBe("/api/_vitehub/blob/posts/cover.jpg?w=640&crop=mobile")
  })

  it("uses the configured route, encodes pathnames once, and keeps served URLs", () => {
    expect(getImage("/my photos/a b.jpg", { baseURL: "/files/", modifiers: { width: 16 } }).url).toBe("/files/my%20photos/a%20b.jpg?w=16")
    expect(getImage("/my%20photos/a.jpg", { baseURL: "/files", modifiers: {} }).url).toBe("/files/my%20photos/a.jpg")
    // The `url` of a media record already points at the route.
    expect(getImage("/files/a.jpg", { baseURL: "/files", modifiers: { width: 640 } }).url).toBe("/files/a.jpg?w=640")
    expect(getImage("https://cdn.example/files/a.jpg?v=2", { baseURL: "https://cdn.example/files", modifiers: { width: 640 } }).url)
      .toBe("https://cdn.example/files/a.jpg?v=2&w=640")
    expect(getImage("/a.jpg", { baseURL: "https://cdn.example/files", modifiers: {} }).url).toBe("https://cdn.example/files/a.jpg")
  })
})
