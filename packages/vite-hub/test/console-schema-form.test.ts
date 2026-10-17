import { describe, expect, it } from "vitest"

import {
  compactConsoleFieldValues,
  consoleDocumentSlug,
  consoleFieldIssues,
  consoleFieldLabel,
  consoleInvalidDocument,
  consolePublishMismatches,
  consoleSchemaDefaults,
  describeConsoleSchemaFields,
  groupConsoleFieldIssues,
  isConsoleDocumentId,
} from "../src/console/runtime/client/documents.ts"
import { ConsoleRequestError } from "../src/console/runtime/client/request.ts"

// The frontmatter schema that Content builds for a typical posts collection.
const posts = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    summary: { type: "string", maxLength: 500, description: "Shown in lists." },
    date: { type: "string", format: "date-time" },
    publishedOn: { type: "string", format: "date" },
    category: { type: "string", enum: ["guide", "release"], default: "guide" },
    tags: { type: "array", items: { type: "string" }, default: [] },
    featured: { type: "boolean", default: false },
    readingTime: { type: "integer", minimum: 1 },
    rating: { anyOf: [{ type: "number" }, { type: "null" }] },
    author: { type: "object", properties: { name: { type: "string" }, url: { type: "string", format: "uri" } }, required: ["name"] },
    cover: { type: "object", properties: { pathname: { type: "string" } }, required: ["pathname"], "x-vitehub-blob": { kind: "image", store: "media" } },
    links: { type: "array", items: { type: "object" } },
    extra: {},
  },
  required: ["title", "date"],
}

describe("Console schema form model", () => {
  it("maps JSON Schema properties to form fields", () => {
    const fields = describeConsoleSchemaFields(posts)
    expect(fields.map(field => [field.name, field.kind, field.required])).toEqual([
      ["title", "string", true],
      ["summary", "text", false],
      ["date", "date-time", true],
      ["publishedOn", "date", false],
      ["category", "enum", false],
      ["tags", "string-list", false],
      ["featured", "boolean", false],
      ["readingTime", "integer", false],
      ["rating", "number", false],
      ["author", "object", false],
      ["cover", "blob", false],
      ["links", "json", false],
      ["extra", "json", false],
    ])
    expect(fields.find(field => field.name === "category")?.enum).toEqual(["guide", "release"])
    expect(fields.find(field => field.name === "summary")).toMatchObject({ description: "Shown in lists.", maxLength: 500 })
    expect(fields.find(field => field.name === "author")?.fields?.map(field => [field.name, field.required])).toEqual([["name", true], ["url", false]])
    expect(fields.find(field => field.name === "readingTime")?.minimum).toBe(1)
    expect(fields.find(field => field.name === "publishedOn")?.label).toBe("Published on")
  })

  it("starts a new document from schema defaults", () => {
    expect(consoleSchemaDefaults(posts)).toEqual({ category: "guide", featured: false, tags: [] })
  })

  it("drops empty optional values before a save", () => {
    const fields = describeConsoleSchemaFields(posts)
    expect(compactConsoleFieldValues(fields, { title: "", summary: "", readingTime: undefined, author: { name: "", url: "" }, tags: [] })).toEqual({ title: "", tags: [] })
    // A required value stays, so its validator reports it.
    expect(compactConsoleFieldValues(fields, { title: "A", author: { name: "", url: "https://a.dev" } })).toEqual({ title: "A", author: { name: "", url: "https://a.dev" } })
  })

  it("derives document ids from titles", () => {
    expect(consoleDocumentSlug("Hello, Wörld! 2026")).toBe("hello-world-2026")
    expect(consoleDocumentSlug("  Launch / Notes  ")).toBe("launch/notes")
    expect(isConsoleDocumentId("2026/launch")).toBe(true)
    for (const id of ["", "/a", "a/", "a//b", "../a", "a\\b"]) expect(isConsoleDocumentId(id), id).toBe(false)
    expect(consoleFieldLabel("readingTime")).toBe("Reading time")
  })

  it("reads per-field issues from a CONTENT_INVALID failure", () => {
    const error = new ConsoleRequestError(422, "Some fields are invalid.", {
      code: "CONTENT_INVALID",
      details: { issues: [{ field: "title", message: "Required", path: [] }, { field: "tags", message: "Expected string", path: [1] }, { field: "author", message: "Required", path: ["name"] }, { bad: true }] },
    })
    const issues = consoleFieldIssues(error)
    expect(issues).toHaveLength(3)
    // List items belong to their field; nested object keys to the nested field.
    expect(groupConsoleFieldIssues(issues!)).toEqual({ "author.name": ["Required"], tags: ["Expected string"], title: ["Required"] })
    expect(consoleFieldIssues(new ConsoleRequestError(409, "Conflict", { code: "WORKSPACE_CONFLICT" }))).toBeUndefined()
  })

  it("reads the documents a publish failure names", () => {
    const moved = new ConsoleRequestError(409, "Changed", {
      code: "WORKSPACE_CONFLICT",
      details: { documents: [{ id: "hello", expected: "a", actual: "b" }, { id: "gone", expected: "c", actual: null }, { expected: "x" }] },
    })
    expect(consolePublishMismatches(moved)).toEqual([{ id: "hello", expected: "a", actual: "b" }, { id: "gone", expected: "c", actual: null }])
    // A save conflict names no documents.
    expect(consolePublishMismatches(new ConsoleRequestError(409, "Changed", { code: "WORKSPACE_CONFLICT", details: { actual: "b" } }))).toBeUndefined()
    const invalid = new ConsoleRequestError(422, "hello has invalid fields.", { code: "CONTENT_INVALID", details: { id: "hello", issues: [] } })
    expect(consoleInvalidDocument(invalid)).toBe("hello")
    expect(consoleInvalidDocument(new ConsoleRequestError(422, "Invalid", { code: "CONTENT_INVALID", details: { issues: [] } }))).toBeUndefined()
  })
})
