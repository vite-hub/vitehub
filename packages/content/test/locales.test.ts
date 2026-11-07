import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { useWorkspace } from "@vite-hub/workspace"
import { lineageDigest, staleDerivedFiles } from "@vite-hub/workspace/lineage"

import { documents } from "../src/collections.ts"
import { contentHead } from "../src/head.ts"
import { defineContent } from "../src/index.ts"
import { historyWorkspace } from "./history-workspace.ts"

import type { DefineContentSeoOptions } from "../src/sitemap.ts"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const fields = { title: z.string().min(1) }

async function setup(options: { url?: string, seo?: DefineContentSeoOptions } = {}) {
  const workspace = await historyWorkspace(cleanup)
  const content = defineContent({
    workspace,
    collections: {
      docs: documents({ path: "docs/{locale}/**/*.md", locales: ["en", "es"], fields, ...(options.url ? { url: options.url } : {}) }),
    },
    ...(options.seo ? { seo: options.seo } : {}),
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

    // A save without sourceDigest keeps the derivedFrom of the translation, so a fix does not mark it current.
    await docs.save("guide", { data: { title: "Guía" }, body: "¡Hola!\n" }, { locale: "es" })
    expect(await docs.get("guide", { ref: "draft", locale: "es" })).toMatchObject({ derivedFrom: source })
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "stale" } })
    // The source digest of the current read marks it current.
    const english = await docs.get("guide", { ref: "draft", locale: "es" })
    await docs.save("guide", { data: { title: "Guía" }, body: "Hola otra vez.\n" }, { locale: "es", sourceDigest: english!.source!.digest })
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "current" } })
  })

  it("records the source version a translation was made from, not the one at save time", async () => {
    const { docs, workspace } = await setup()
    await docs.save("guide", { data: { title: "Guide" }, body: "Version A.\n" })
    // A translator reads source A from the fallback read.
    const read = await docs.get("guide", { ref: "draft", locale: "es" })
    const a = { path: "docs/en/guide.md", digest: lineageDigest(await draftBytes(workspace, "docs/en/guide.md")) }
    expect(read).toMatchObject({ locale: "en", fallback: true, source: a })
    expect(await docs.get("guide", { ref: "draft" })).toMatchObject({ source: a })
    // Someone saves source B before the translation of A is saved.
    await docs.save("guide", { data: { title: "Guide" }, body: "Version B.\n" })
    const b = lineageDigest(await draftBytes(workspace, "docs/en/guide.md"))
    const spanish = await docs.save("guide", { data: { title: "Guía" }, body: "Versión A.\n" }, { locale: "es", sourceDigest: read!.source!.digest })
    expect(spanish.derivedFrom).toEqual(a)
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "stale" } })
    // A read of the translation names the current source, so the caller sees what changed.
    expect(await docs.get("guide", { ref: "draft", locale: "es" })).toMatchObject({ locale: "es", derivedFrom: a, source: { path: a.path, digest: b } })
    // A typo fix keeps it stale.
    await docs.save("guide", { data: { title: "Guía" }, body: "Versión A, sin errata.\n" }, { locale: "es" })
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "stale" } })
    // A translation of B marks it current.
    await docs.save("guide", { data: { title: "Guía" }, body: "Versión B.\n" }, { locale: "es", sourceDigest: b })
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "current" } })

    // derivedFrom is Content's to write, and sourceDigest is only for a translation in the lineage form.
    await docs.save("guide", { data: Object.assign({ title: "Guía" }, { derivedFrom: a }), body: "Versión B.\n" }, { locale: "es" })
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "current" } })
    expect(await rejection(docs.save("guide", { data: { title: "Guía" } }, { locale: "es", sourceDigest: read!.digest }))).toMatchObject({ code: "CONTENT_R0008", message: expect.stringMatching(/source\.digest/) })
    expect(await rejection(docs.save("guide", { data: { title: "Guide" } }, { sourceDigest: b }))).toMatchObject({ code: "CONTENT_R0008", message: expect.stringMatching(/translation/) })
  })

  it("compares a translation written through Workspace with the source locale file of its id only", async () => {
    const { docs, workspace } = await setup()
    await docs.save("guide", { data: { title: "Guide" }, body: "Hello.\n" })
    await docs.save("intro", { data: { title: "Intro" } })
    const history = useWorkspace(workspace as never, { mode: "write" }).history
    const write = async (derivedFrom: { path: string, digest: string }) => {
      const head = await history.head({ ref: "draft" })
      const text = `---\ntitle: Guía\nderivedFrom:\n  path: ${derivedFrom.path}\n  digest: ${derivedFrom.digest}\n---\nHola.\n`
      await history.commit({ ref: "draft", ifHead: head!.id, changes: { put: { "docs/es/guide.md": { content: text } } } })
    }
    // derivedFrom names another file whose digest matches, so it says nothing about docs/en/guide.md.
    const intro = { path: "docs/en/intro.md", digest: lineageDigest(await draftBytes(workspace, "docs/en/intro.md")) }
    await write(intro)
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "stale" } })
    await docs.save("guide", { data: { title: "Guide" }, body: "Hello again.\n" })
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "stale" } })

    // The same write that names the source locale file of the id is current.
    await write({ path: "docs/en/guide.md", digest: lineageDigest(await draftBytes(workspace, "docs/en/guide.md")) })
    expect(await docs.status("guide")).toMatchObject({ translations: { es: "current" } })
  })

  it("publishes a translation by id when the source locale has no version", async () => {
    const { content, docs } = await setup()
    await docs.save("only-es", { data: { title: "Solo" } }, { locale: "es" })
    expect(await content.publish({ collection: "docs", ids: ["only-es"] })).toMatchObject({
      documents: [{ collection: "docs", id: "only-es", locale: "es", change: "add" }],
    })
    expect(await rejection(content.publish({ collection: "docs", ids: ["nowhere"] }))).toMatchObject({ code: "CONTENT_NOT_FOUND" })
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

  it("serves the Markdown copy of each locale", async () => {
    const { content, docs } = await setup({ url: "/docs/:id", seo: { site: "https://example.com", markdown: true } })
    await docs.save("guide", { data: { title: "Guide" }, body: "Hello." })
    await docs.save("intro", { data: { title: "Intro" }, body: "Start." })
    await docs.save("guide", { data: { title: "Guía" }, body: "Hola." }, { locale: "es" })
    await content.publish({ collection: "docs" })
    expect(await content.markdown("/docs/guide.md")).toBe("# Guide\n\nHello.\n")
    expect(await content.markdown("/es/docs/guide.md")).toBe("# Guía\n\nHola.\n")
    // A page without a translation shows the source locale, and so does its copy.
    expect(await content.markdown("/es/docs/intro.md")).toBe("# Intro\n\nStart.\n")
  })

  it("lists each published translation in the sitemap, without fallback pages", async () => {
    const { content, docs } = await setup({ url: "/docs/:id", seo: { site: "https://example.com", sitemap: true } })
    await docs.save("guide", { data: { title: "Guide" } })
    await docs.save("intro", { data: { title: "Intro" } })
    await docs.save("guide", { data: { title: "Guía" } }, { locale: "es" })
    await content.publish({ collection: "docs" })
    expect((await content.sitemap()).map(({ loc, locale }) => ({ loc, locale }))).toEqual([
      { loc: "https://example.com/docs/guide", locale: "en" },
      { loc: "https://example.com/docs/intro", locale: "en" },
      { loc: "https://example.com/es/docs/guide", locale: "es" },
    ])
  })

  it("gives the page of each locale its document and head", async () => {
    const { content, docs } = await setup({ url: "/docs/:id" })
    await docs.save("guide", { data: { title: "Guide" } })
    await docs.save("intro", { data: { title: "Intro" } })
    await docs.save("guide", { data: { title: "Guía" } }, { locale: "es" })
    await content.publish({ collection: "docs" })
    // What a catch-all page does: find the document of the path, read it in the locale of the path, and build the head.
    const page = async (path: string) => {
      const route = await content.resolve(path)
      const document = await docs.get(route!.id, { locale: route!.locale })
      return { document, head: contentHead(document, { site: { url: "https://example.com" }, collection: docs }) }
    }
    const alternates = [
      { rel: "alternate", hreflang: "en", href: "https://example.com/docs/guide" },
      { rel: "alternate", hreflang: "es", href: "https://example.com/es/docs/guide" },
      { rel: "alternate", hreflang: "x-default", href: "https://example.com/docs/guide" },
    ]

    const spanish = await page("/es/docs/guide")
    expect(spanish.document).toMatchObject({
      locale: "es",
      data: { title: "Guía" },
      alternates: [{ locale: "en", url: "/docs/guide" }, { locale: "es", url: "/es/docs/guide" }],
    })
    expect(spanish.head.htmlAttrs).toEqual({ lang: "es" })
    expect(spanish.head.link).toEqual([{ rel: "canonical", href: "https://example.com/es/docs/guide" }, ...alternates])

    const english = await page("/docs/guide")
    expect(english.head.htmlAttrs).toEqual({ lang: "en" })
    expect(english.head.link).toEqual([{ rel: "canonical", href: "https://example.com/docs/guide" }, ...alternates])

    // Without a translation, the Spanish page shows English, says so in lang, and is canonical to the English page.
    const fallback = await page("/es/docs/intro")
    expect(fallback.document).toMatchObject({ locale: "en", fallback: true, url: "/es/docs/intro", alternates: [{ locale: "en", url: "/docs/intro" }] })
    expect(fallback.head.htmlAttrs).toEqual({ lang: "en" })
    expect(fallback.head.link).toEqual([{ rel: "canonical", href: "https://example.com/docs/intro" }])
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

  it("reads a locale field in the url of a collection without locales", async () => {
    const workspace = await historyWorkspace(cleanup)
    const posts = documents({ path: "posts/*.md", url: "/:locale/blog/:id", fields: { title: z.string(), locale: z.string() } })
    const content = defineContent({ workspace, collections: { posts }, logger: false })
    cleanup.push(() => content.dispose())
    await content.collection("posts").save("hello", { data: { title: "Hola", locale: "es" } })
    await content.publish({ collection: "posts" })
    expect(await content.resolve("/es/blog/hello")).toEqual({ collection: "posts", id: "hello" })
  })
})
