import { parse as parseYaml } from "yaml"
import { describe, expect, it } from "vitest"

import { consoleDocumentHasBody, consoleDocumentText } from "../src/console/runtime/client/documents.ts"
import { parseConsoleDocumentCollections } from "../src/console/runtime/definitions.ts"

const data = {
  title: "Hello: world",
  draft: false,
  count: 3,
  version: "1.0",
  flag: "yes",
  author: { name: "Ada", links: [{ label: "Site", url: "https://ada.dev" }], empty: {} },
  tags: ["vue", "-dash"],
  none: [],
}

describe("Console document files", () => {
  it("renders nested frontmatter as YAML blocks that read back to the same values", () => {
    const text = consoleDocumentText({ body: "Body", data }, "markdown")
    expect(text).toContain("author:\n  name: Ada\n  links:\n    - label: Site\n      url: https://ada.dev\n")
    expect(text).not.toContain("{\"name\"")
    expect(text.endsWith("---\n\nBody\n")).toBe(true)
    const frontmatter = /^---\n([\s\S]*?)---\n/.exec(text)![1]!
    expect(parseYaml(frontmatter)).toEqual(data)
  })

  it("renders JSON and YAML documents without a body", () => {
    expect(consoleDocumentText({ body: "", data }, "json")).toBe(`${JSON.stringify(data, null, 2)}\n`)
    const yaml = consoleDocumentText({ body: "", data }, "yaml")
    expect(yaml.startsWith("title: \"Hello: world\"\n")).toBe(true)
    expect(parseYaml(yaml)).toEqual(data)
    expect(consoleDocumentText({ body: "", data: {} }, "yaml")).toBe("{}\n")
  })

  it("reads singletons and formats from the collections an owner returns", () => {
    const base = { access: { read: true }, label: "Settings", name: "settings", path: "settings.json", schema: { type: "object" } }
    expect(parseConsoleDocumentCollections([{ ...base, kind: "singleton", document: "settings", format: "json" }])[0]).toMatchObject({ kind: "singleton", document: "settings", format: "json" })
    // An owner that predates singletons lists collections, and a singleton needs its id.
    expect(parseConsoleDocumentCollections([base])[0]).not.toHaveProperty("kind")
    expect(parseConsoleDocumentCollections([base])[0]).not.toHaveProperty("format")
    expect(parseConsoleDocumentCollections([{ ...base, kind: "singleton" }])[0]).not.toHaveProperty("kind")
    expect(parseConsoleDocumentCollections([{ ...base, kind: "documents", format: "yaml" }])[0]).toMatchObject({ kind: "documents", format: "yaml" })
    expect(consoleDocumentHasBody({ format: "yaml" })).toBe(false)
    expect(consoleDocumentHasBody({})).toBe(true)
  })
})
