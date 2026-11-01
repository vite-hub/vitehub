import { getSchema } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { createContentEditorCodec } from "@vite-hub/content/editor"
import { describe, expect, it } from "vitest"

import {
  consoleComponentDefaults,
  consoleComponentProp,
  consoleComponentWithProp,
  consoleEditorComponents,
  consoleEditorMedia,
  consoleHeadingSlug,
  consoleSlashGroups,
  splitConsoleFrontmatter,
} from "../src/console/runtime/client/editor.ts"

import type { ConsoleDocumentComponent } from "../src/console/runtime/definitions.ts"

const alert: ConsoleDocumentComponent = { description: "A highlighted note", kind: "block", label: "Alert", name: "alert", props: { type: { default: "info", type: "string" } } }
const badge: ConsoleDocumentComponent = { kind: "inline", label: "Badge", name: "badge", props: {} }

describe("Console body editor menus", () => {
  it("resolves media for display without rewriting stored paths", async () => {
    const codec = createContentEditorCodec()
    const schema = getSchema([StarterKit, consoleEditorMedia(src => `/served/${src}`)])
    for (const { file, tag } of [{ file: "photo.png", tag: "img" }, { file: "movie.mp4", tag: "video" }, { file: "sound.mp3", tag: "audio" }]) {
      const markdown = `![Media](uploads/${file})`
      const doc = await codec.fromMarkdown(markdown)
      const image = schema.nodeFromJSON(doc).firstChild?.firstChild
      if (!image) throw new Error("The document has no media node")
      expect(image.type.spec.toDOM?.(image)).toEqual([tag, expect.objectContaining({ src: `/served/uploads/${file}` })])
      expect(await codec.toMarkdown(doc)).toContain(`](uploads/${file})`)
    }
  })
  it("groups the slash menu and lists collection components last with their Markdown", () => {
    const groups = consoleSlashGroups([alert, badge])
    expect(groups.map(group => group[0])).toEqual([
      { label: "Basic blocks", type: "label" },
      { label: "Media", type: "label" },
      { label: "Components", type: "label" },
    ])
    expect(groups[0]!.slice(1).map(item => item.label)).toEqual(["Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "Quote", "Code", "Divider", "Table"])
    expect(groups[2]!.slice(1)).toEqual([
      expect.objectContaining({ component: "alert", description: "::alert", keywords: expect.arrayContaining(["alert", "highlighted", "note"]), kind: "component" }),
      expect.objectContaining({ component: "badge", description: ":badge", kind: "component" }),
    ])
    expect(consoleSlashGroups([])).toHaveLength(2)
  })

  it("keeps component names separate from schema node names", () => {
    const table = { ...alert, name: "table" }
    expect(consoleEditorComponents([alert, table, { ...badge, name: "Bad" }])).toEqual([alert, table])
    expect(consoleEditorComponents(undefined)).toEqual([])
    expect(consoleComponentDefaults(alert)).toEqual({ type: "info" })
  })

  it("reads and edits typed component props without leaving stale bindings", async () => {
    const codec = createContentEditorCodec()
    const doc = await codec.fromMarkdown('::card{:count="3" :enabled="true"}\nHello\n::\n')
    const component = doc.content?.[0]
    expect(component?.attrs?.name).toBe("card")
    const props = component?.attrs?.props ?? {}
    expect(consoleComponentProp(props, "count", "number")).toBe(3)
    expect(consoleComponentProp(props, "enabled", "boolean")).toBe(true)
    const changed = consoleComponentWithProp(props, "enabled", false)
    expect(changed).not.toHaveProperty(":enabled")
    if (!component?.attrs) throw new Error("The component has no props")
    component.attrs.props = changed
    const markdown = await codec.toMarkdown(doc)
    const saved = (await codec.fromMarkdown(markdown)).content?.[0]?.attrs?.props ?? {}
    expect(consoleComponentProp(saved, "enabled", "boolean")).toBe(false)
    expect(consoleComponentProp(saved, "count", "number")).toBe(3)
  })

  it("splits the stored file into frontmatter and body", () => {
    expect(splitConsoleFrontmatter("---\ntitle: Hi\n---\n\nBody\n")).toEqual({ body: "\nBody\n", frontmatter: "---\ntitle: Hi\n---\n" })
    expect(splitConsoleFrontmatter("---\n---\nBody")).toEqual({ body: "Body", frontmatter: "---\n---\n" })
    expect(splitConsoleFrontmatter("Body only")).toEqual({ body: "Body only", frontmatter: "" })
    expect(consoleHeadingSlug("Getting started, fast!")).toBe("getting-started-fast")
  })

  it("keeps undeclared components editable with Comark UI's shared codec", async () => {
    const codec = createContentEditorCodec()
    const body = "Intro.\n\n::note\nHello\n::\n\n* one\n* two\n\n_em_\n"
    expect(await codec.verify(body)).toMatchObject({ writable: true })
    const written = await codec.toMarkdown(await codec.fromMarkdown(body))
    expect(written).toContain("::note")
    expect(written).toContain("Hello")
  })
})
