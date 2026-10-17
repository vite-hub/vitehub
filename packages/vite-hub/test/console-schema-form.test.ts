import { describe, expect, it } from "vitest"

import {
  compactConsoleFieldValues,
  consoleDocumentSlug,
  consoleFieldIssueMessage,
  consoleFieldIssues,
  consoleFieldLabel,
  consoleFieldValueIssue,
  consoleInvalidDocument,
  consoleListQuery,
  consoleListQueryFor,
  consolePublishMismatches,
  consoleSchemaDefaults,
  consoleSingularLabel,
  describeConsoleSchemaFields,
  groupConsoleFieldIssues,
  groupConsoleRevisionRuns,
  groupConsoleRevisions,
  humanizeConsoleFieldIssues,
  isConsoleDocumentId,
  parseConsoleListQuery,
  rememberConsoleListQuery,
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
    social: { type: "array", items: { type: "string", format: "uri" } },
    days: { type: "array", items: { type: "string", format: "date" } },
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
      ["social", "string-list", false],
      ["days", "json", false],
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

  it("writes field issues as the field name and the constraint", () => {
    expect(consoleFieldIssueMessage("Name", "Invalid input: expected string, received undefined")).toBe("Name is required.")
    expect(consoleFieldIssueMessage("Title", "Too small: expected string to have >=1 characters")).toBe("Title must be at least 1 characters.")
    expect(consoleFieldIssueMessage("Summary", "Too big: expected string to have <=280 characters")).toBe("Summary must be at most 280 characters.")
    expect(consoleFieldIssueMessage("Reading time", "Too small: expected number to be >=1")).toBe("Reading time must be at least 1.")
    expect(consoleFieldIssueMessage("Url", "Invalid URL")).toBe("Url must be a valid URL.")
    expect(consoleFieldIssueMessage("Category", "Invalid option: expected one of \"guide\"|\"release\"")).toBe("Category must be one of the listed options.")
    expect(consoleFieldIssueMessage("Featured", "Invalid input: expected boolean, received string")).toBe("Featured must be on or off.")
    // Messages the collection author wrote stay as written.
    expect(consoleFieldIssueMessage("Title", "Add a title.")).toBe("Add a title.")
    expect(consoleFieldIssueMessage("Summary", "Keep the summary under 280 characters.")).toBe("Keep the summary under 280 characters.")

    const fields = describeConsoleSchemaFields(posts)
    expect(humanizeConsoleFieldIssues(fields, [
      { field: "author", message: "Invalid input: expected string, received undefined", path: ["name"] },
      { field: "title", message: "Required", path: [] },
      { field: "unknown", message: "Odd", path: [] },
    ]).map(issue => issue.message)).toEqual(["Author name is required.", "Title is required.", "Odd"])
  })

  it("checks a value on blur against the schema constraints", () => {
    const fields = Object.fromEntries(describeConsoleSchemaFields({ ...posts, required: ["title"] }).map(field => [field.name, field]))
    expect(consoleFieldValueIssue(fields.title!, "  ")).toBe("Title is required.")
    expect(consoleFieldValueIssue(fields.title!, "Hello")).toBeUndefined()
    expect(consoleFieldValueIssue(fields.summary!, "x".repeat(501))).toBe("Summary must be at most 500 characters.")
    expect(consoleFieldValueIssue(fields.readingTime!, 0)).toBe("Reading time must be at least 1.")
    expect(consoleFieldValueIssue(fields.readingTime!, 1.5)).toBe("Reading time must be a whole number.")
    // Optional empty values and shapes the form cannot check pass.
    expect(consoleFieldValueIssue(fields.summary!, "")).toBeUndefined()
    expect(consoleFieldValueIssue(fields.author!, {})).toBeUndefined()
    const url = fields.author!.fields!.find(field => field.name === "url")!
    expect(consoleFieldValueIssue(url, "vitehub dev")).toBe("Url must be a valid URL.")
    expect(consoleFieldValueIssue(url, "https://vitehub.dev")).toBeUndefined()
  })

  it("keeps the list view in the URL without defaults", () => {
    const options = { facets: ["category", "tags"], sorts: ["date:desc", "date:asc", "id:asc"] }
    const view = parseConsoleListQuery({ q: "launch", state: "draft", sort: "id:asc", "filter.category": "story", "filter.nope": "x" }, options)
    expect(view).toEqual({ filters: { category: "story" }, search: "launch", sort: "id:asc", state: "draft" })
    expect(consoleListQuery(view, "date:desc")).toEqual({ "filter.category": "story", q: "launch", sort: "id:asc", state: "draft" })
    // Unknown values fall back to the defaults, and defaults leave the query empty.
    const fallback = parseConsoleListQuery({ state: "archived", sort: "title:asc" }, options)
    expect(fallback).toEqual({ filters: {}, search: "", sort: "date:desc", state: "all" })
    expect(consoleListQuery(fallback, "date:desc")).toEqual({})
    rememberConsoleListQuery("posts", { state: "draft" })
    expect(consoleListQueryFor("posts")).toEqual({ state: "draft" })
    expect(consoleListQueryFor("pages")).toEqual({})
  })

  it("groups revisions by day and names collections in the singular", () => {
    const now = Date.parse("2026-10-14T12:00:00.000Z")
    const revision = (id: string, createdAt: string) => ({ action: "save", createdAt, id, ref: "draft" })
    const groups = groupConsoleRevisions([
      revision("a", "2026-10-14T11:00:00.000Z"),
      revision("b", "2026-10-14T01:00:00.000Z"),
      revision("c", "2026-10-13T09:00:00.000Z"),
      revision("d", "2026-10-02T09:00:00.000Z"),
      revision("e", "2025-12-30T09:00:00.000Z"),
    ], now, "UTC")
    expect(groups.map(group => [group.label, group.revisions.map(entry => entry.id).join("")])).toEqual([
      ["Today", "ab"],
      ["Yesterday", "c"],
      ["Oct 2", "d"],
      ["Dec 30, 2025", "e"],
    ])
    expect(consoleSingularLabel("Posts")).toBe("Post")
    expect(consoleSingularLabel("Pages")).toBe("Page")
    expect(consoleSingularLabel("Stories")).toBe("Story")
    expect(consoleSingularLabel("News")).toBe("Document")
    expect(consoleSingularLabel("Glass")).toBe("Document")
    expect(consoleSingularLabel("Release notes")).toBe("Document")
  })

  it("collapses consecutive autosaves by one author into one History run", () => {
    const save = (id: string, createdAt: string, author = "Ada", action = "save") => ({ action, author, createdAt, id, ref: "draft" })
    const runs = groupConsoleRevisionRuns([
      save("a", "2026-10-14T11:10:00.000Z"),
      save("b", "2026-10-14T11:09:00.000Z"),
      save("c", "2026-10-14T11:00:00.000Z"),
      save("d", "2026-10-14T10:58:00.000Z", "Wes"),
      save("e", "2026-10-14T10:57:00.000Z", "Ada", "publish"),
      save("f", "2026-10-14T10:56:00.000Z"),
      save("g", "2026-10-14T10:30:00.000Z"),
    ])
    // Wes's save, the publish, and a save after a 26-minute pause each break the run.
    expect(runs.map(run => run.revisions.map(entry => entry.id).join(""))).toEqual(["abc", "d", "e", "f", "g"])
  })
})
