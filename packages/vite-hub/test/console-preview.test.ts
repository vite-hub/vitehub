import { describe, expect, it } from "vitest"

import {
  clearConsoleLocalDraft,
  consoleEditorMinWidth,
  consolePreviewField,
  consolePreviewFormAction,
  consolePreviewFormValue,
  consolePreviewMinWidth,
  consolePreviewUrl,
  consolePreviewWidth,
  readConsoleLocalDraft,
  writeConsoleLocalDraft,
} from "../src/console/runtime/client/preview.ts"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

describe("console preview", () => {
  it("previews only pages on the Console origin", () => {
    expect(consolePreviewUrl("/blog/hello", "https://site.test")?.href).toBe("https://site.test/blog/hello")
    expect(consolePreviewUrl("https://site.test/blog/hello?x=1", "https://site.test")?.search).toBe("?x=1")
    expect(consolePreviewUrl("https://evil.test/blog/hello", "https://site.test")).toBeUndefined()
    expect(consolePreviewUrl("//evil.test/x", "https://site.test")).toBeUndefined()
    expect(consolePreviewUrl("javascript:alert(1)", "https://site.test")).toBeUndefined()
    expect(consolePreviewUrl(undefined, "https://site.test")).toBeUndefined()
  })

  it("posts the token and the document in the form body, never in the URL", () => {
    const url = new URL("https://site.test/blog/hello?lang=en")
    const action = consolePreviewFormAction(url, "vitehub-content-preview")
    expect(action).toBe("https://site.test/blog/hello?lang=en&vitehub-content-preview=")
    expect(action).not.toContain("f1.")
    const value = consolePreviewFormValue("f1.1.scope.sig", { collection: "posts", id: "hello", data: { title: "Local" }, body: "# Hi" })
    expect(JSON.parse(value)).toEqual({ token: "f1.1.scope.sig", document: { collection: "posts", id: "hello", data: { title: "Local" }, body: "# Hi" } })
  })

  it("matches contentField() marks of the edited document only", () => {
    const posts = { name: "posts", kind: "documents" as const }
    expect(consolePreviewField("posts:hello#title", posts, "hello")).toEqual({ field: "title", nested: false })
    expect(consolePreviewField("posts:hello#author.name", posts, "hello")).toEqual({ field: "author", nested: true })
    expect(consolePreviewField("posts:other#title", posts, "hello")).toBeUndefined()
    expect(consolePreviewField("pages:hello#title", posts, "hello")).toBeUndefined()
    expect(consolePreviewField("posts#title", posts, "hello")).toBeUndefined()
    expect(consolePreviewField(null, posts, "hello")).toBeUndefined()
    const settings = { name: "settings", kind: "singleton" as const }
    expect(consolePreviewField("settings#title", settings, "settings")).toEqual({ field: "title", nested: false })
  })

  it("keeps both panes at their minimum widths", () => {
    expect(consolePreviewWidth(10, 1400)).toBe(consolePreviewMinWidth)
    expect(consolePreviewWidth(5000, 1400)).toBe(1400 - consoleEditorMinWidth)
    expect(consolePreviewWidth(600.4, 1400)).toBe(600)
    expect(consolePreviewWidth(600, 500)).toBe(consolePreviewMinWidth)
  })

  it("keeps local-only edits per document in tab storage and reads nothing else as them", () => {
    const storage = memoryStorage()
    const draft = { base: "digest-1", start: { body: "a", data: { title: "A" } }, version: { body: "b", data: { title: "B" } } }
    expect(writeConsoleLocalDraft(storage, "posts", "hello", draft)).toBe(true)
    expect(readConsoleLocalDraft(storage, "posts", "hello")).toEqual(draft)
    expect(readConsoleLocalDraft(storage, "posts", "other")).toBeUndefined()
    storage.setItem("vitehub:console:local:posts/broken", "{not json")
    expect(readConsoleLocalDraft(storage, "posts", "broken")).toBeUndefined()
    storage.setItem("vitehub:console:local:posts/shape", JSON.stringify({ base: 1, start: {}, version: {} }))
    expect(readConsoleLocalDraft(storage, "posts", "shape")).toBeUndefined()
    clearConsoleLocalDraft(storage, "posts", "hello")
    expect(readConsoleLocalDraft(storage, "posts", "hello")).toBeUndefined()
    expect(writeConsoleLocalDraft({ setItem: () => { throw new Error("quota") } }, "posts", "hello", draft)).toBe(false)
  })
})
