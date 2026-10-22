import { contentMarkdownLossOf } from "@vite-hub/content/editor"
import { describe, expect, it } from "vitest"

import {
  consoleComponentDefaults,
  consoleComponentRecord,
  consoleEditorComponents,
  consoleHeadingSlug,
  consoleSlashGroups,
  splitConsoleFrontmatter,
} from "../src/console/runtime/client/editor.ts"

import type { ConsoleDocumentComponent } from "../src/console/runtime/definitions.ts"

const alert: ConsoleDocumentComponent = { description: "A highlighted note", kind: "block", label: "Alert", name: "alert", props: { type: { default: "info", type: "string" } } }
const badge: ConsoleDocumentComponent = { kind: "inline", label: "Badge", name: "badge", props: {} }

describe("Console body editor menus", () => {
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

  it("registers only components that cannot shadow a built-in node", () => {
    const table = { ...alert, name: "table" }
    expect(consoleEditorComponents([alert, table, { ...badge, name: "Bad" }])).toEqual([alert])
    expect(consoleEditorComponents(undefined)).toEqual([])
    expect(consoleComponentDefaults(alert)).toEqual({ type: "info" })
  })

  it("splits the stored file into frontmatter and body", () => {
    expect(splitConsoleFrontmatter("---\ntitle: Hi\n---\n\nBody\n")).toEqual({ body: "\nBody\n", frontmatter: "---\ntitle: Hi\n---\n" })
    expect(splitConsoleFrontmatter("---\n---\nBody")).toEqual({ body: "Body", frontmatter: "---\n---\n" })
    expect(splitConsoleFrontmatter("Body only")).toEqual({ body: "Body only", frontmatter: "" })
    expect(consoleHeadingSlug("Getting started, fast!")).toBe("getting-started-fast")
  })

  it("tells formatting changes from Markdown the rich editor would drop, with Content's check", async () => {
    const stored = "Intro.\n\n::note\nHello\n::\n\n* one\n* two\n\n_em_\n"
    expect(await contentMarkdownLossOf(stored, "Intro.\n\n::note\nHello\n::\n\n- one\n- two\n\n*em*\n")).toBeUndefined()
    expect(await contentMarkdownLossOf(stored, "Intro.\n\nHello\n\n- one\n- two\n\n*em*\n")).toMatchObject({ lost: ["note"] })
  })

  it("keeps an alert without a type editable: the declared default is form, not loss", async () => {
    const components = consoleComponentRecord([alert, badge])
    expect(components).toEqual({ alert: { kind: "block", props: { type: { default: "info", type: "string" } } }, badge: { kind: "inline", props: {} } })
    expect(await contentMarkdownLossOf("::alert\nCareful.\n::\n", "::alert{type=\"info\"}\nCareful.\n::\n", { components })).toBeUndefined()
  })
})
