import { describe, expect, it } from "vitest"

import { file, image } from "../src/index.ts"

import type { BlobObject } from "../src/index.ts"

const uploaded: BlobObject = {
  pathname: "posts/cover.png",
  contentType: "image/png",
  size: 2048,
  httpEtag: "\"etag\"",
  uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
  httpMetadata: {},
  customMetadata: { source: "upload" },
  url: "https://cdn.example.com/posts/cover.png",
}

function messages(result: ReturnType<ReturnType<typeof image>["~standard"]["validate"]>) {
  return result.issues?.map(issue => ({ message: issue.message, path: issue.path }))
}

describe("Blob reference schemas", () => {
  it("stores a put() or handleUpload() result as a minimal reference", () => {
    expect(image()["~standard"].validate(uploaded)).toEqual({
      value: { pathname: "posts/cover.png", contentType: "image/png", size: 2048 },
    })
    expect(file()["~standard"].validate(JSON.parse(JSON.stringify(uploaded)))).toEqual({
      value: { pathname: "posts/cover.png", contentType: "image/png", size: 2048 },
    })
  })

  it("implements Standard Schema v1 with a vitehub vendor", () => {
    const standard = image()["~standard"]
    expect(standard.version).toBe(1)
    expect(standard.vendor).toBe("vitehub")
  })

  it("keeps optional fields out of the value when they are absent", () => {
    expect(file()["~standard"].validate({ pathname: "docs/guide.pdf", contentType: undefined })).toEqual({
      value: { pathname: "docs/guide.pdf" },
    })
  })

  it("rejects values that are not reference objects", () => {
    for (const value of [undefined, null, "posts/cover.png", ["posts/cover.png"]]) {
      expect(messages(image()["~standard"].validate(value))).toEqual([{
        message: "Image must be a Blob reference object with a pathname, such as the result of blob.put().",
        path: undefined,
      }])
    }
  })

  it.each([
    [{ pathname: 1 }, "Blob pathname must be a string."],
    [{ pathname: "" }, "Blob pathname must not be empty."],
    [{ pathname: "/posts/cover.png" }, "Blob pathname must be relative to its Blob Store, without a leading slash."],
    [{ pathname: "posts\\cover.png" }, "Blob pathname must use forward slashes."],
    [{ pathname: "posts/\u0000cover.png" }, "Blob pathname must not contain control characters."],
    [{ pathname: "posts/../secrets.txt" }, "Blob pathname must not contain \".\" or \"..\" segments."],
    [{ pathname: "./cover.png" }, "Blob pathname must not contain \".\" or \"..\" segments."],
    [{ pathname: "posts//cover.png" }, "Blob pathname must not contain empty segments or a trailing slash."],
    [{ pathname: "posts/" }, "Blob pathname must not contain empty segments or a trailing slash."],
    [{ pathname: "https://cdn.example.com/cover.png" }, "Blob pathname must not contain empty segments or a trailing slash."],
    [{ pathname: "_vitehub/derived/abc/preview" }, "Blob pathname must not point into the reserved _vitehub/derived namespace."],
    [{ pathname: "_VITEHUB" }, "Blob pathname must not point into the reserved _vitehub/derived namespace."],
  ])("rejects the unsafe pathname in %j", (value, message) => {
    expect(messages(file()["~standard"].validate(value))).toEqual([{ message, path: ["pathname"] }])
  })

  it("accepts nested pathnames with dots inside segments", () => {
    expect(file()["~standard"].validate({ pathname: "users/1/.config/v1.2.tar.gz" })).toEqual({
      value: { pathname: "users/1/.config/v1.2.tar.gz" },
    })
    expect(file()["~standard"].validate({ pathname: "_vitehub/exports/report.csv" }).issues).toBeUndefined()
  })

  it("defaults image() to image types and requires a content type to check", () => {
    expect(messages(image()["~standard"].validate({ pathname: "a.pdf", contentType: "application/pdf" }))).toEqual([{
      message: "Image type \"application/pdf\" is not accepted. Accepted types: image/*.",
      path: ["contentType"],
    }])
    expect(messages(image()["~standard"].validate({ pathname: "a.png" }))).toEqual([{
      message: "Image needs a contentType to check it against image/*.",
      path: ["contentType"],
    }])
    expect(image()["~standard"].validate({ pathname: "a.svg", contentType: "Image/SVG+XML; charset=utf-8" }).issues).toBeUndefined()
    expect(image()["~standard"].validate({ pathname: "a.svg", contentType: "image/\n" }).issues).toHaveLength(1)
  })

  it("lets file() accept every type unless accept is set", () => {
    expect(file()["~standard"].validate({ pathname: "a.bin" }).issues).toBeUndefined()
    const pdf = file({ accept: ["application/pdf", "text/*"] })
    expect(pdf["~standard"].validate({ pathname: "a.pdf", contentType: "application/pdf" }).issues).toBeUndefined()
    expect(pdf["~standard"].validate({ pathname: "a.md", contentType: "text/markdown" }).issues).toBeUndefined()
    expect(messages(pdf["~standard"].validate({ pathname: "a.png", contentType: "image/png" }))).toEqual([{
      message: "File type \"image/png\" is not accepted. Accepted types: application/pdf, text/*.",
      path: ["contentType"],
    }])
  })

  it("lets image() narrow or widen accepted types", () => {
    const png = image({ accept: "image/png" })
    expect(png["~standard"].validate({ pathname: "a.png", contentType: "image/png" }).issues).toBeUndefined()
    expect(png["~standard"].validate({ pathname: "a.jpg", contentType: "image/jpeg" }).issues).toHaveLength(1)
    expect(image({ accept: "*/*" })["~standard"].validate({ pathname: "a.bin" }).issues).toBeUndefined()
  })

  it("checks the recorded size against maxSize", () => {
    const small = image({ maxSize: "1KB" })
    expect(small["~standard"].validate({ pathname: "a.png", contentType: "image/png", size: 1024 }).issues).toBeUndefined()
    expect(messages(small["~standard"].validate({ pathname: "a.png", contentType: "image/png", size: 1025 }))).toEqual([{
      message: "Image is 1025 bytes, larger than maxSize 1KB (1024 bytes).",
      path: ["size"],
    }])
    // maxSize checks only a recorded size; enforce the real limit at upload with ensureBlob().
    expect(small["~standard"].validate({ pathname: "a.png", contentType: "image/png" }).issues).toBeUndefined()
  })

  it("reports every invalid field at once", () => {
    expect(messages(image()["~standard"].validate({ pathname: "../a", contentType: "", size: -1 }))).toEqual([
      { message: "Blob pathname must not contain \".\" or \"..\" segments.", path: ["pathname"] },
      { message: "Blob contentType must be a non-empty string.", path: ["contentType"] },
      { message: "Blob size must be a non-negative integer number of bytes.", path: ["size"] },
    ])
    expect(file()["~standard"].validate({ pathname: "a", size: 1.5 }).issues).toHaveLength(1)
  })

  it("rejects invalid options when the schema is defined", () => {
    expect(() => image({ accept: "png" })).toThrow("[vitehub] image() accept entry \"png\" is not a MIME type or pattern such as \"image/png\" or \"image/*\".")
    expect(() => file({ accept: [".pdf"] })).toThrow("accept entry \".pdf\"")
    // @ts-expect-error BlobSize accepts powers of two with a unit.
    expect(() => file({ maxSize: "3 megabytes" })).toThrow("[vitehub] file() maxSize \"3 megabytes\" is not a size such as \"512KB\" or \"8MB\".")
    expect(() => file({ store: "" })).toThrow("[vitehub] file() store must be a non-empty Blob Store name.")
  })

  it("emits JSON Schema with an x-vitehub-blob hint", () => {
    const schema = image()["~standard"].jsonSchema.input({ target: "draft-2020-12" })
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        pathname: { type: "string", minLength: 1, description: "Pathname in the Blob Store." },
        contentType: { type: "string", minLength: 1, description: "MIME type recorded at upload." },
        size: { type: "integer", minimum: 0, description: "Size in bytes recorded at upload." },
      },
      required: ["pathname", "contentType"],
      "x-vitehub-blob": { kind: "image", store: "default", accept: ["image/*"] },
    })
    const properties = (schema as { properties: { pathname: { pattern: string }, contentType: { pattern: string } } }).properties
    const pathname = new RegExp(properties.pathname.pattern)
    expect(pathname.test("posts/cover.png")).toBe(true)
    expect(pathname.test("posts/../secrets.txt")).toBe(false)
    expect(pathname.test("_VITEHUB")).toBe(false)
    const contentType = new RegExp(properties.contentType.pattern)
    expect(contentType.test("Image/SVG+XML; charset=utf-8")).toBe(true)
    expect(contentType.test("  IMAGE/PNG  ")).toBe(true)
    expect(contentType.test("image/png ; charset=utf-8")).toBe(true)
    expect(contentType.test("image/png; parameter=one\nparameter=two")).toBe(true)
    expect(contentType.test("image/\n")).toBe(false)
    expect(contentType.test("application/pdf")).toBe(false)
    const svg = file({ accept: "image/svg+xml" })
    const svgPattern = (svg["~standard"].jsonSchema.input({ target: "draft-07" }) as { properties: { contentType: { pattern: string } } }).properties.contentType.pattern
    expect(new RegExp(svgPattern).test("image/svg+xml; charset=utf-8")).toBe(true)
    expect(new RegExp(svgPattern).test("image/svg+xml; charset=\nutf-8")).toBe(true)
    expect(new RegExp(svgPattern).test("image/svgxml")).toBe(false)
  })

  it("carries store, accept, and maxSize into the hint and output schema", () => {
    const schema = file({ store: "media", accept: "application/pdf", maxSize: "8MB" })
    const output = schema["~standard"].jsonSchema.output({ target: "draft-07" })
    expect(output).toMatchObject({
      additionalProperties: false,
      required: ["pathname", "contentType"],
      properties: { size: { maximum: 8 * 1024 * 1024 } },
      "x-vitehub-blob": { kind: "file", store: "media", accept: ["application/pdf"], maxSize: "8MB" },
    })
    expect(file()["~standard"].jsonSchema.input({ target: "openapi-3.0" })).toMatchObject({
      required: ["pathname"],
      "x-vitehub-blob": { kind: "file", store: "default" },
    })
    expect(file()["~standard"].jsonSchema.input({ target: "openapi-3.0" })["x-vitehub-blob"]).not.toHaveProperty("accept")
  })

  it.each(["draft-07", "draft-2020-12", "openapi-3.0"])("bounds JSON Schema sizes to safe integers for %s", (target) => {
    for (const factory of [file, image]) {
      for (const maxSize of [undefined, "1KB"] as const) {
        const standard = factory({ maxSize })["~standard"]
        const maximum = maxSize ? 1024 : Number.MAX_SAFE_INTEGER
        for (const direction of ["input", "output"] as const) {
          expect(standard.jsonSchema[direction]({ target })).toMatchObject({
            properties: { size: { type: "integer", minimum: 0, maximum } },
          })
        }
        expect(standard.validate({ pathname: "a.png", contentType: "image/png", size: maximum }).issues).toBeUndefined()
        expect(standard.validate({ pathname: "a.png", contentType: "image/png", size: maximum + 1 }).issues).toHaveLength(1)
      }
    }
  })

  it("returns a fresh JSON Schema object on each call", () => {
    const schema = image()
    const first = schema["~standard"].jsonSchema.input({ target: "draft-07" })
    ;(first["x-vitehub-blob"] as { accept: string[] }).accept.push("text/*")
    expect(schema["~standard"].jsonSchema.input({ target: "draft-07" })["x-vitehub-blob"]).toEqual({
      kind: "image",
      store: "default",
      accept: ["image/*"],
    })
    expect(schema["~standard"].validate({ pathname: "a.txt", contentType: "text/plain" }).issues).toHaveLength(1)
  })

  it("throws for JSON Schema targets it cannot emit", () => {
    expect(() => image()["~standard"].jsonSchema.input({ target: "draft-04" })).toThrow(
      "[vitehub] Blob reference schemas emit draft-07, draft-2020-12, or openapi-3.0 JSON Schema, not \"draft-04\".",
    )
  })
})
