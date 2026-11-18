import { expect, it } from "vitest"
import { z } from "zod"

import { documents } from "../src/collections.ts"
import { contentErrorDiagnostics } from "../src/error-diagnostics.ts"
import { contentSource, defineContent, defineContentPreset, seo } from "../src/index.ts"
import { contentDefinitionErrorCodes, contentInputErrorCodes } from "../src/input-errors.ts"

// The causes that CONTENT_R0006 and CONTENT_R0008 covered, each with its own code and fix.
const splitCodes = [...contentDefinitionErrorCodes, ...contentInputErrorCodes].sort()

const guide = { async items() { return [{ key: "guide", path: "guide.md", content: "# Guide" }] } }
const fields = { title: z.string() }
const preset = defineContentPreset({ name: "test", options: { workspace: "content" }, configure: options => ({ workspace: options.workspace }) })

function fixOf(code: string): string {
  const create = Reflect.get(contentErrorDiagnostics, code) as (params: object) => { fix?: string }
  return create({}).fix!
}

function thrown(work: () => unknown): unknown {
  try {
    work()
  }
  catch (error) {
    return error
  }
  throw new Error("expected an error")
}

it("gives each split Content code a fix and its own docs page", () => {
  expect(splitCodes).toHaveLength(59)
  for (const code of splitCodes) {
    const create = Reflect.get(contentErrorDiagnostics, code) as ((params: object) => { fix?: string, docs?: string }) | undefined
    expect(create, code).toBeInstanceOf(Function)
    const error = create!({})
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/content/diagnostics/${code.toLowerCase()}`)
  }
})

it.each([
  ["CONTENT_ACCESS_INVALID", () => defineContent({ source: guide, access: "open" as never })],
  ["CONTENT_AUTHORIZE_INVALID", () => defineContent({ source: guide, authorize: "yes" as never })],
  ["CONTENT_COLLECTION_DEFINITION_INVALID", () => defineContent({ workspace: "content", collections: { posts: {} as never } })],
  ["CONTENT_COLLECTION_PATHS_OVERLAP", () => defineContent({ workspace: "content", collections: { a: documents({ path: "posts/*.md", fields }), b: documents({ path: "posts/**/*.md", fields }) } })],
  ["CONTENT_COLLECTIONS_WORKSPACE_MISSING", () => defineContent({ collections: { posts: documents({ path: "posts/*.md", fields }) } })],
  ["CONTENT_DOCUMENTS_COMPONENTS_INVALID", () => documents({ path: "posts/*.md", fields, components: { Alert: {} } as never })],
  ["CONTENT_DOCUMENTS_FIELD_RESERVED", () => documents({ path: "docs/{locale}/*.md", locales: ["en", "es"], fields: { derivedFrom: z.string() } })],
  ["CONTENT_DOCUMENTS_FIELDS_INVALID", () => documents({ path: "posts/*.md", fields: { title: "text" } as never })],
  ["CONTENT_DOCUMENTS_LABEL_INVALID", () => documents({ path: "posts/*.md", fields, label: "" })],
  ["CONTENT_DOCUMENTS_LOCALES_INVALID", () => documents({ path: "docs/{locale}/*.md", locales: [], fields })],
  ["CONTENT_DOCUMENTS_OPTIONS_INVALID", () => documents({ path: "posts/*.md", fields, search: "title" as never })],
  ["CONTENT_DOCUMENTS_PATH_INVALID", () => documents({ path: [], fields })],
  ["CONTENT_DOCUMENTS_URL_INVALID", () => documents({ path: "posts/*.md", fields, url: "blog/:id" as never })],
  ["CONTENT_LIVE_INVALID", () => defineContent({ source: guide, live: true as never })],
  ["CONTENT_PLUGINS_PARSE_PLUGIN", () => defineContent({ source: guide, plugins: [{ name: "knap", pre() {} } as never] })],
  ["CONTENT_PRESET_CONFIGURE_INVALID", () => defineContent({ source: guide, extends: defineContentPreset({ name: "empty", options: {}, configure: () => null as never }) })],
  ["CONTENT_PRESET_INVALID", () => defineContent({ source: guide, extends: { workspace: "content" } as never })],
  ["CONTENT_PRESET_OPTION_UNKNOWN", () => defineContent({ source: guide, extends: [preset, { speed: "x" } as never] })],
  ["CONTENT_PRESET_WORKSPACE_CONFLICT", () => defineContent({ source: guide, extends: preset, workspace: "site" })],
  ["CONTENT_ROUTE_INVALID", () => defineContent({ source: guide, route: "public" as never })],
  ["CONTENT_SEO_FIELD_INVALID", () => seo({ image: "image" as never })],
  ["CONTENT_SEO_OPTIONS_INVALID", () => defineContent({ source: guide, seo: { sitemap: "yes" as never } })],
  ["CONTENT_SOURCE_OPTIONS_INVALID", () => contentSource(guide, { url: "docs/:id" })],
])("puts the fix of %s on the error that the definition throws", (code, work) => {
  expect(thrown(work)).toMatchObject({ code, fix: fixOf(code) })
})

it("puts the fix of a bad runtime argument on the rejected error", async () => {
  const content = defineContent({ access: "public", source: guide, logger: false })
  try {
    await expect(content.can(null as never)).rejects.toMatchObject({ code: "CONTENT_CAN_INPUT_INVALID", fix: fixOf("CONTENT_CAN_INPUT_INVALID") })
    await expect(content.preview.enable(new Request("https://site.test/"))).rejects.toMatchObject({ code: "CONTENT_COLLECTIONS_UNDEFINED", fix: fixOf("CONTENT_COLLECTIONS_UNDEFINED") })
    await expect(content.history("")).rejects.toMatchObject({ code: "CONTENT_HISTORY_INPUT_INVALID", fix: fixOf("CONTENT_HISTORY_INPUT_INVALID") })
  }
  finally {
    await content.dispose()
  }
})
