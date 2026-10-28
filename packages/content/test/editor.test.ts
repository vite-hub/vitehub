import { readdir, readFile } from "node:fs/promises"

import { createRealtimeYDoc, readRealtimeYDoc } from "@vite-hub/realtime/server"
import { describe, expect, it } from "vitest"

import { contentRealtimeEditor } from "../src/editor.ts"

/** How the codec treats each fixture body: kept as written, kept in its own form, or read-only with the reason. */
const verdicts: Record<string, "exact" | "canonical" | "readonly"> = {
  "cases/blockquote.md": "exact",
  "cases/code-fence-meta.md": "exact",
  "cases/code-fence-variants.md": "canonical",
  "cases/empty.md": "exact",
  "cases/escapes.md": "canonical",
  "cases/footnotes.md": "exact",
  "cases/hard-breaks.md": "canonical",
  "cases/headings.md": "exact",
  "cases/html-comments.md": "readonly",
  "cases/html-raw.md": "canonical",
  "cases/images-attrs.md": "exact",
  "cases/list-markers.md": "readonly",
  "cases/marks-code-link.md": "exact",
  "cases/mdc-block-explicit-default.md": "exact",
  "cases/mdc-block-html-attrs.md": "canonical",
  "cases/mdc-block-multi-child.md": "exact",
  "cases/mdc-block-no-props.md": "exact",
  "cases/mdc-block-props.md": "exact",
  "cases/mdc-block-yaml-props.md": "canonical",
  "cases/mdc-inline-attrs.md": "exact",
  "cases/mdc-inline.md": "exact",
  "cases/mdc-nested.md": "canonical",
  "cases/mdc-slots.md": "exact",
  "cases/mdc-span-attrs.md": "exact",
  "cases/mdc-unknown-block.md": "exact",
  "cases/mdc-unknown-inline.md": "exact",
  "cases/misc-inline.md": "exact",
  "cases/nested-lists.md": "exact",
  "cases/no-final-newline.md": "exact",
  "cases/ordered-loose-list.md": "exact",
  "cases/playground-body-1.md": "exact",
  "cases/playground-body-2.md": "exact",
  "cases/playground-body-3.md": "exact",
  "cases/playground-full-file-with-frontmatter.md": "readonly",
  "cases/reference-links.md": "canonical",
  "cases/style-variants.md": "canonical",
  "cases/table-compact.md": "canonical",
  "cases/table.md": "canonical",
  "cases/task-list.md": "exact",
  "cases/trailing-whitespace.md": "canonical",
  "cases/two-final-newlines.md": "canonical",
  "extra/body-starts-with-hr.md": "exact",
  "extra/entities.md": "canonical",
  "extra/escapes-line-start.md": "exact",
  "extra/html-details.md": "canonical",
  "extra/linkify.md": "canonical",
  "extra/mdc-typed-props.md": "canonical",
  "extra/table-escaped-pipe.md": "canonical",
}

/** Fixture bodies: the Markdown corpus, and the playground posts without their frontmatter, as Content splits them. */
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
  const editor = contentRealtimeEditor()

  it("keeps a body read-only when the base parser would drop a footnote definition", async () => {
    await expect(editor.verify!("Text[^a].\n\n[^a]: footnote.\n", {})).resolves.toMatchObject({ writable: false })
  })

  it("verifies every fixture: kept as written, kept in its own form, or read-only without changing the body", async () => {
    const seen: string[] = []
    for (const [name, body] of await fixtures()) {
      const result = await editor.verify!(body, {})
      const expected = verdicts[name] ?? "exact"
      seen.push(name)
      if (expected === "exact") expect(result, name).toEqual({ writable: true })
      else if (expected === "canonical") expect(result, name).toEqual({ canonical: expect.any(String), writable: true })
      else {
        expect(result, name).toEqual({ writable: false, issues: [{ field: "body", message: "The editor cannot keep this Markdown unchanged. Edit this body in Source.", path: ["body"] }] })
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

  it("keeps undeclared components, named slots, attributes, and task lists editable", async () => {
    const body = "::unknown{custom=\"kept\"}\n#footer\n- [x] A task.\n::\n"
    const result = await editor.verify!(body, {})
    expect(result.writable).toBe(true)
    const written = await editor.toMarkdown(await editor.fromMarkdown(body))
    expect(written).toContain("::unknown{custom=\"kept\"}")
    expect(written).toContain("#footer")
    expect(written).toContain("[x] A task.")
  })

  it("opens an empty body with one empty paragraph", async () => {
    expect(await editor.fromMarkdown("")).toMatchObject({ type: "doc", content: [{ type: "paragraph" }] })
  })
})
