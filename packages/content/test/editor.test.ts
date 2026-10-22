import { readdir, readFile } from "node:fs/promises"

import { createRealtimeYDoc, readRealtimeYDoc } from "@vite-hub/realtime/server"
import { parseMarkdown } from "comark"
import { describe, expect, it } from "vitest"

import { contentEditorComponents, contentMarkdownLoss, contentMarkdownLossOf, contentRealtimeEditor, describeContentMarkdownLoss } from "../src/editor.ts"

import type { DocumentComponent } from "../src/documents.ts"

const components: Record<string, DocumentComponent> = {
  alert: { kind: "block", props: { type: { type: "string", default: "info" } } },
  badge: { kind: "inline" },
}

/** How the codec treats each fixture body: kept as written, kept in its own form, or read-only with the reason. */
const verdicts: Record<string, "exact" | "canonical" | string> = {
  "cases/blockquote.md": "exact",
  "cases/code-fence-meta.md": "exact",
  "cases/code-fence-variants.md": "canonical",
  "cases/empty.md": "exact",
  "cases/escapes.md": "canonical",
  "cases/footnotes.md": "[text]{.class} spans and footnotes",
  "cases/hard-breaks.md": "canonical",
  "cases/headings.md": "heading ids such as {#custom-id}",
  "cases/html-comments.md": "canonical",
  "cases/html-raw.md": "<div> HTML and <kbd> HTML",
  "cases/images-attrs.md": "canonical",
  "cases/list-markers.md": "lists that follow each other with different markers",
  "cases/marks-code-link.md": "exact",
  "cases/mdc-block-explicit-default.md": "exact",
  "cases/mdc-block-html-attrs.md": "canonical",
  "cases/mdc-block-multi-child.md": "canonical",
  "cases/mdc-block-no-props.md": "canonical",
  "cases/mdc-block-props.md": "exact",
  "cases/mdc-block-yaml-props.md": "canonical",
  "cases/mdc-inline-attrs.md": "exact",
  "cases/mdc-inline.md": "exact",
  "cases/mdc-nested.md": "canonical",
  "cases/mdc-slots.md": "exact",
  "cases/mdc-span-attrs.md": "[text]{.class} spans and footnotes",
  "cases/mdc-unknown-block.md": "the ::callout component",
  "cases/mdc-unknown-inline.md": "the :icon component",
  "cases/misc-inline.md": ":rocket:",
  "cases/nested-lists.md": "exact",
  "cases/no-final-newline.md": "exact",
  "cases/ordered-loose-list.md": "exact",
  "cases/playground-body-1.md": "exact",
  "cases/playground-body-2.md": "exact",
  "cases/playground-body-3.md": "exact",
  "cases/playground-full-file-with-frontmatter.md": "a frontmatter block at the start of the body",
  "cases/reference-links.md": "canonical",
  "cases/style-variants.md": "canonical",
  "cases/table-compact.md": "canonical",
  "cases/table.md": "canonical",
  "cases/task-list.md": "task lists",
  "cases/trailing-whitespace.md": "canonical",
  "cases/two-final-newlines.md": "canonical",
  "extra/body-starts-with-hr.md": "exact",
  "extra/entities.md": "canonical",
  "extra/escapes-line-start.md": "exact",
  "extra/html-details.md": "<details> HTML and <summary> HTML",
  "extra/linkify.md": "canonical",
  "extra/mdc-typed-props.md": "canonical",
  "extra/table-escaped-pipe.md": "canonical",
}

/** Fixture bodies: the comark-tiptap spike corpus, and the playground posts without their frontmatter, as Content splits them. */
async function fixtures(): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = []
  for (const folder of ["cases", "extra", "playground"]) {
    const files = (await readdir(new URL(`./fixtures/markdown/${folder}`, import.meta.url))).sort()
    for (const file of files) {
      const text = await readFile(new URL(`./fixtures/markdown/${folder}/${file}`, import.meta.url), "utf8")
      result.push([`${folder}/${file}`, folder === "playground" ? text.replace(/^---\n[\s\S]*?\n---\n+/, "") : text])
    }
  }
  return result
}

describe("contentRealtimeEditor", () => {
  const editor = contentRealtimeEditor({ components })

  it("verifies every fixture: kept as written, kept in its own form, or read-only naming the construct", async () => {
    const seen: string[] = []
    for (const [name, body] of await fixtures()) {
      const result = await editor.verify!(body, {})
      const expected = verdicts[name] ?? "exact"
      seen.push(name)
      if (expected === "exact") expect(result, name).toEqual({ writable: true })
      else if (expected === "canonical") expect(result, name).toEqual({ canonical: expect.any(String), writable: true })
      else {
        expect(result, name).toEqual({ writable: false, issues: [{ field: "body", message: `The editor cannot keep ${expected}. Edit this body in Source.`, path: ["body"] }] })
      }
    }
    expect(seen.filter(name => name.startsWith("playground/"))).toHaveLength(12)
  })

  it("round-trips writable fixtures through a Yjs room without changing them again", async () => {
    for (const [name, body] of await fixtures()) {
      const result = await editor.verify!(body, {})
      if (!result.writable) continue
      const expected = result.canonical ?? body
      const room = await createRealtimeYDoc(editor, { body })
      const read = await readRealtimeYDoc(editor, room)
      room.destroy()
      // The room keeps the final newline separately; the codec drops it.
      expect(read.body.trimEnd(), name).toBe(expected.trimEnd())
      // The canonical form is stable: verifying it again keeps it as written.
      if (result.canonical !== undefined) expect(await editor.verify!(result.canonical, {}), name).toEqual({ writable: true })
    }
  })

  it("writes a declared default, which counts as form and not as loss", async () => {
    expect(await editor.verify!("::alert\nA note.\n::\n", {})).toEqual({ canonical: "::alert{type=\"info\"}\nA note.\n::\n", writable: true })
  })

  it("opens an empty body with one empty paragraph", async () => {
    expect(await editor.fromMarkdown("")).toMatchObject({ type: "doc", content: [{ type: "paragraph" }] })
  })

  it("builds the same components for every editor, without tags that shadow built-in nodes", () => {
    const built = contentEditorComponents({ ...components, heading: { kind: "block" }, "Bad Tag": { kind: "block" } }, definition => definition)
    expect(built).toEqual([
      { kind: "block", name: "alert", props: { type: { default: "info", type: "string" } } },
      { kind: "inline", name: "badge", props: {} },
    ])
  })
})

describe("contentMarkdownLoss", () => {
  async function nodes(markdown: string) {
    return (await parseMarkdown(markdown, { autoClose: false, headingIds: false })).nodes
  }

  it("ignores attribute key order", async () => {
    expect(contentMarkdownLoss(await nodes("![a](/a.png){width=\"3\" .round}"), await nodes("![a](/a.png){.round width=\"3\"}"))).toBeUndefined()
  })

  it("treats a missing prop and its declared default as the same", async () => {
    expect(contentMarkdownLoss(await nodes("::alert\nHi\n::"), await nodes("::alert{type=\"info\"}\nHi\n::"), { components })).toBeUndefined()
    expect(contentMarkdownLoss(await nodes("::alert\nHi\n::"), await nodes("::alert{type=\"warning\"}\nHi\n::"), { components })).toEqual({ lost: [], constructs: ["attributes on <alert>"] })
    // Without the declaration the default is new content.
    expect(contentMarkdownLoss(await nodes("::alert\nHi\n::"), await nodes("::alert{type=\"info\"}\nHi\n::"))).toBeDefined()
  })

  it("reads typed props written with or without the Comark prefix alike", async () => {
    const typed = { counter: { kind: "block" as const, props: { count: { type: "number" as const }, open: { type: "boolean" as const } } } }
    expect(contentMarkdownLoss(await nodes("::counter{:count=\"3\" :open=\"true\"}\n::"), await nodes("::counter{count=\"3\" open=\"true\"}\n::"), { components: typed })).toBeUndefined()
  })

  it("accepts a reference link written inline", async () => {
    expect(await contentMarkdownLossOf("A [link][ref].\n\n[ref]: https://example.com \"Title\"\n", "A [link](https://example.com){title=\"Title\"}.\n")).toBeUndefined()
  })

  it("names what disappears", async () => {
    const loss = await contentMarkdownLossOf("Press <kbd>K</kbd>.\n\n::callout\nNote\n::\n", "Press K.\n\nNote\n")
    expect(loss).toEqual({ lost: ["kbd", "callout"], constructs: ["<kbd> HTML", "the ::callout component"] })
    expect(describeContentMarkdownLoss(loss!)).toBe("The editor cannot keep <kbd> HTML and the ::callout component. Edit this body in Source.")
  })
})
