import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { useWorkspace } from "@vite-hub/workspace"
import { lineageDigest, staleDerivedFiles } from "@vite-hub/workspace/lineage"

import { documents } from "../src/collections.ts"
import { defineContent } from "../src/index.ts"
import { historyWorkspace } from "./history-workspace.ts"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const fields = { title: z.string().min(1) }

async function setup(options: { url?: string } = {}) {
  const workspace = await historyWorkspace(cleanup)
  const content = defineContent({
    workspace,
    collections: {
      docs: documents({ path: "docs/{locale}/**/*.md", locales: ["en", "es"], fields, ...(options.url ? { url: options.url } : {}) }),
    },
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return { content, docs: content.collection("docs"), workspace }
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

/** The bytes of a draft file, as `workspace.stale` reads them. */
async function draftBytes(workspace: string, path: string): Promise<Uint8Array> {
  const history = useWorkspace(workspace as never, { mode: "write" }).history
  const head = await history.head({ ref: "draft" })
  return await (await history.open(head!.id)).readFile(path, { encoding: "binary" })
}

describe("documents() with locales", () => {
  it("checks locales and the {locale} folder", () => {
    expect(documents({ path: "docs/{locale}/**/*.md", locales: ["en", "es"], fields })).toMatchObject({
      locales: ["en", "es"],
      localePaths: ["docs/{locale}/**/*.md"],
      path: "docs/{locale}/**/*.md",
      paths: ["docs/en/**/*.md", "docs/es/**/*.md"],
    })
    for (const options of [
      { path: "docs/{locale}/*.md" },
      { path: "docs/*.md", locales: ["en"] },
      { path: "docs/{locale}/*.md", locales: [] },
      { path: "docs/{locale}/*.md", locales: ["en", "en"] },
      { path: "docs/{locale}/*.md", locales: ["en/us"] },
      { path: "docs/*/{locale}.md", locales: ["en"] },
      { path: "docs/{locale}-x/*.md", locales: ["en"] },
      { path: ["docs/{locale}/*.md", "blog/{locale}/*.md"], locales: ["en"] },
      { path: "docs/{locale}/*.md", locales: ["en"], url: "/:lang/:id" },
    ]) {
      expect(() => documents({ fields, ...options }), JSON.stringify(options)).toThrow(expect.objectContaining({ code: "CONTENT_R0006" }))
    }
    expect(() => documents({ path: "docs/{locale}/*.md", locales: ["en"], fields: { derivedFrom: z.string() } })).toThrow(/derivedFrom/)
    expect(documents({ path: ["docs/{locale}/guides/*.md", "docs/{locale}/blog/*.md"], locales: ["en", "pt-BR"], fields }).paths)
      .toEqual(["docs/en/guides/*.md", "docs/en/blog/*.md", "docs/pt-BR/guides/*.md", "docs/pt-BR/blog/*.md"])
  })

  it("keeps ids across locales and falls back to the source locale", async () => {
    const { docs } = await setup()
    const english = await docs.save("guide", { data: { title: "Guide" }, body: "Hello.\n" })
    expect(english).toMatchObject({ id: "guide", locale: "en", path: "docs/en/guide.md" })
    expect(english.derivedFrom).toBeUndefined()
    await docs.save("intro", { data: { title: "Intro" } })

    const fallback = await docs.get("guide", { ref: "draft", locale: "es" })
    expect(fallback).toMatchObject({ id: "guide", locale: "en", fallback: true, path: "docs/en/guide.md", data: { title: "Guide" } })
    expect(await docs.raw("guide", { ref: "draft", locale: "es" })).toBeNull()

    const spanish = await docs.save("guide", { data: { title: "Guía" }, body: "Hola.\n" }, { locale: "es" })
    expect(spanish).toMatchObject({ id: "guide", locale: "es", path: "docs/es/guide.md", data: { title: "Guía" } })
    expect(spanish).not.toHaveProperty("fallback")
    expect(await docs.get("guide", { ref: "draft", locale: "es" })).toMatchObject({ locale: "es", body: "Hola.\n" })
    expect(await docs.get("guide", { ref: "draft" })).toMatchObject({ locale: "en", body: "Hello.\n" })

    const page = await docs.list({ ref: "draft", locale: "es" })
    expect(page.items.map(item => [item.id, item.locale, item.fallback ?? false])).toEqual([["guide", "es", false], ["intro", "en", true]])
    expect((await docs.list({ ref: "draft" })).items.map(item => [item.id, item.locale])).toEqual([["guide", "en"], ["intro", "en"]])
    expect(await rejection(docs.get("guide", { locale: "fr" }))).toMatchObject({ code: "CONTENT_R0008" })
  })

  it("records derivedFrom on translations and reports stale and missing ones", async () => {
    const { docs, workspace } = await setup()
    await docs.save("guide", { data: { title: "Guide" }, body: "Hello.\n" })
    await docs.save("intro", { data: { title: "Intro" } })
    const spanish = await docs.save("guide", { data: { title: "Guía" }, body: "Hola.\n" }, { locale: "es" })
    const source = { path: "docs/en/guide.md", digest: lineageDigest(await draftBytes(workspace, "docs/en/guide.md")) }
    expect(spanish.derivedFrom).toEqual(source)
    expect(await docs.raw("guide", { ref: "draft", locale: "es" })).toMatchObject({ text: expect.stringContaining(`derivedFrom:\n  path: docs/en/guide.md\n  digest: ${source.digest}\n`) })
    // Workspace lineage reads the same record.
    expect(staleDerivedFiles(new Map([
      ["docs/en/guide.md", await draftBytes(workspace, "docs/en/guide.md")],
      ["docs/es/guide.md", await draftBytes(workspace, "docs/es/guide.md")],
    ]))).toEqual([])

    expect((await docs.status()).map(status => [status.id, status.locale, status.translations])).toEqual([
      ["guide", "en", { es: "current" }],
      ["intro", "en", { es: "missing" }],
    ])

    await docs.save("guide", { data: { title: "Guide" }, body: "Hello again.\n" })
    expect(await docs.status("guide")).toMatchObject({ locale: "en", translations: { es: "stale" } })
    expect((await docs.status({ locale: "es" })).map(status => [status.id, status.locale, status.state])).toEqual([["guide", "es", "draft"]])
    expect(await docs.status({ locale: "es" })).not.toContainEqual(expect.objectContaining({ translations: expect.anything() }))

    // A caller's derivedFrom wins, so a fix that is not a new translation can keep it stale.
    await docs.save("guide", { data: { title: "Guía" }, body: "¡Hola!\n", derivedFrom: spanish.derivedFrom! }, { locale: "es" })
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "stale" } })
    await docs.save("guide", { data: { title: "Guía" }, body: "Hola otra vez.\n" }, { locale: "es" })
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "current" } })
  })

  it("publishes every locale and resolves locale URLs", async () => {
    const { content, docs } = await setup({ url: "/docs/:id" })
    await docs.save("guide", { data: { title: "Guide" } })
    await docs.save("intro", { data: { title: "Intro" } })
    await docs.save("guide", { data: { title: "Guía" } }, { locale: "es" })
    const result = await content.publish({ collection: "docs" })
    expect(result.documents).toEqual([
      { collection: "docs", id: "guide", locale: "en", change: "add" },
      { collection: "docs", id: "intro", locale: "en", change: "add" },
      { collection: "docs", id: "guide", locale: "es", change: "add" },
    ])
    expect(await docs.get("guide", { locale: "es" })).toMatchObject({ locale: "es", url: "/es/docs/guide" })
    expect(await docs.get("intro", { locale: "es" })).toMatchObject({ locale: "en", fallback: true, url: "/es/docs/intro" })
    expect(await docs.get("intro")).toMatchObject({ url: "/docs/intro" })
    expect(await content.resolve("/docs/guide")).toEqual({ collection: "docs", id: "guide", locale: "en" })
    expect(await content.resolve("/es/docs/guide")).toEqual({ collection: "docs", id: "guide", locale: "es" })
    expect(await content.resolve("/es/docs/intro")).toEqual({ collection: "docs", id: "intro", locale: "es" })

    const spanish = await docs.save("guide", { data: { title: "Guía 2" } }, { locale: "es" })
    expect(await rejection(content.publish({ expect: [{ collection: "docs", id: "guide", locale: "es", digest: "stale" }] }))).toMatchObject({ code: "WORKSPACE_CONFLICT" })
    expect((await content.publish({ expect: [{ collection: "docs", id: "guide", locale: "es", digest: spanish.digest }] })).documents)
      .toEqual([{ collection: "docs", id: "guide", locale: "es", change: "update" }])
    expect(await rejection(content.schedule({ at: new Date(Date.now() + 3_600_000).toISOString(), expect: [{ collection: "docs", id: "guide", locale: "es", digest: spanish.digest }] })))
      .toMatchObject({ code: "CONTENT_R0011" })
  })

  it("puts :locale where the url pattern says", async () => {
    const { docs } = await setup({ url: "/:locale/docs/:id" })
    await docs.save("guide", { data: { title: "Guide" } })
    expect(await docs.get("guide", { ref: "draft" })).toMatchObject({ url: "/en/docs/guide" })
    expect(await docs.get("guide", { ref: "draft", locale: "es" })).toMatchObject({ url: "/es/docs/guide", fallback: true })
  })

  it("leaves a collection without locales as it was", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({ workspace, collections: { posts: documents({ path: "posts/*.md", fields }) }, logger: false })
    cleanup.push(() => content.dispose())
    const posts = content.collection("posts")
    const saved = await posts.save("hello", { data: { title: "Hello" } })
    expect(saved).not.toHaveProperty("locale")
    expect(saved).not.toHaveProperty("derivedFrom")
    expect(await posts.status("hello")).not.toHaveProperty("translations")
    expect(posts).not.toHaveProperty("locales")
    expect(await rejection(posts.get("hello", { locale: "en" }))).toMatchObject({ code: "CONTENT_R0008" })
  })
})
