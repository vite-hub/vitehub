import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { createRecord, parseRecord } from "@diglot/core"
import { writeRecord } from "@diglot/store"
import { compileMessage } from "@lingui/message-utils/compileMessage"
import { describe, expect, it, vi } from "vitest"

import { createLiveTranslations, readRevisionRecords } from "../src/live.ts"
import { resolveI18nLocaleConfig } from "../src/locales.ts"
import { messageSegment, recordPath } from "../src/record-format.ts"
import { messageId, readRecords } from "../src/records.ts"
import { configureI18n, getI18n, setLocale, translate } from "../src/runtime.ts"
import { i18nCatalogResponse, installI18nServer, useTranslations } from "../src/server.ts"

import type { WritableTranslationsWorkspace } from "../src/live.ts"

/** A Workspace history in memory: each ref is a list of revisions with a full file set. */
function memoryWorkspace() {
  const revisions = new Map<string, Record<string, string>>()
  const heads = new Map<string, string>()
  let failing = false
  let reads = 0
  const workspace: WritableTranslationsWorkspace = {
    history: {
      async head({ ref }) {
        reads++
        if (failing) throw new Error("store is down")
        const id = heads.get(ref)
        return id ? { id } : null
      },
      async open(id) {
        const files = revisions.get(id)!
        return {
          list: async (folder, options) => Object.keys(files).filter(path => path.startsWith(`${folder}/`) && (options?.recursive || !path.slice(folder.length + 1).includes("/"))).map(path => ({ path, type: "file" })),
          readFile: async path => files[path]!,
        }
      },
      async commit({ ref, ifHead, changes }) {
        if ((heads.get(ref) ?? null) !== ifHead) throw new Error("conflict")
        const base = ifHead ? revisions.get(ifHead)! : {}
        const id = `${ref}-${revisions.size + 1}`
        const files = { ...base, ...changes.put }
        for (const path of changes.delete ?? []) delete files[path]
        revisions.set(id, files)
        heads.set(ref, id)
        return { id }
      },
    },
  }
  return { workspace, heads, fail: (value: boolean) => { failing = value }, reads: () => reads }
}

const config = { ...resolveI18nLocaleConfig({ locales: ["en", "es"] }), catalogs: {} }
const deploy = { hash: messageSegment("Deploy your agent").hash, id: messageId("Deploy your agent"), message: "Deploy your agent" }
const note = { hash: messageSegment("Server only note").hash, id: messageId("Server only note"), message: "Server only note" }

function record(source: string, text: string, context?: string) {
  return createRecord({ segment: messageSegment(source, context), text, origin: "human", review: "edited" })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => resolve = done)
  return { promise, resolve }
}

describe("Workspace records", () => {
  it("skips invalid ICU without blocking valid translations in later revisions", async () => {
    const store = memoryWorkspace()
    const snapshot = { [note.id]: compileMessage("Nota del servidor") }
    const live = createLiveTranslations({
      workspace: () => store.workspace,
      locales: ["en", "es"],
      sourceLocale: "en",
      snapshot: { es: snapshot },
      clientIds: [deploy.id, note.id],
      interval: 0,
    })
    let head: string | null = null
    for (const translation of ["Primera", "Segunda"]) {
      const revision = await store.workspace.history.commit({
        ref: "published",
        ifHead: head,
        changes: { put: {
          [recordPath("es", note.hash)]: JSON.stringify(record(note.message, "{count, plural,")),
          [recordPath("es", deploy.hash)]: JSON.stringify(record(deploy.message, translation)),
        } },
      })
      head = revision.id
      await live.refresh()
      expect(live.revision).toBe(revision.id)
      // Invalid records keep the build or source fallback, as file-backed records do.
      expect(live.messages("es")).toEqual({ ...snapshot, [deploy.id]: compileMessage(translation) })
      expect(live.clientMessages("es")).toEqual({ [deploy.id]: compileMessage(translation) })
    }
  })

  it.each([undefined, "checkout"])("skips records whose source and context %s do not match their filename", async (context) => {
    const store = memoryWorkspace()
    const valid = record(deploy.message, "Publica tu agente", context)
    const id = messageId(valid.source, valid.salt)
    const revision = await store.workspace.history.commit({
      ref: "published",
      ifHead: null,
      changes: { put: {
        [recordPath("es", valid.hash)]: JSON.stringify(valid),
        [recordPath("es", note.hash)]: JSON.stringify({ ...record(deploy.message, "Wrong message", context), hash: note.hash }),
      } },
    })
    expect(await readRevisionRecords(await store.workspace.history.open(revision.id), ["es"])).toEqual({ es: { [id]: valid } })
  })

  it("skips malformed JSON without blocking valid records in later revisions", async () => {
    const store = memoryWorkspace()
    const first = await store.workspace.history.commit({
      ref: "published",
      ifHead: null,
      changes: { put: {
        [recordPath("es", note.hash)]: "{",
        [recordPath("es", deploy.hash)]: JSON.stringify(record(deploy.message, "Primera")),
      } },
    })
    const onError = vi.fn()
    const live = createLiveTranslations({
      workspace: () => store.workspace,
      locales: ["en", "es"],
      sourceLocale: "en",
      snapshot: {},
      clientIds: [deploy.id, note.id],
      interval: 0,
      onError,
    })
    await live.refresh()
    expect(live.revision).toBe(first.id)
    expect(live.messages("es")).toEqual({ [deploy.id]: compileMessage("Primera") })
    const second = await store.workspace.history.commit({
      ref: "published",
      ifHead: first.id,
      changes: { put: { [recordPath("es", deploy.hash)]: JSON.stringify(record(deploy.message, "Segunda")) } },
    })
    await live.refresh()
    expect(live.revision).toBe(second.id)
    expect(live.clientMessages("es")).toEqual({ [deploy.id]: compileMessage("Segunda") })
    expect(onError).not.toHaveBeenCalled()
  })
})

describe("forced Workspace refreshes", () => {
  it("reads the newly published head after an in-flight refresh captured the old head", async () => {
    const store = memoryWorkspace()
    const put = (translation: string) => ({ [recordPath("es", deploy.hash)]: JSON.stringify(record(deploy.message, translation)) })
    const first = await store.workspace.history.commit({ ref: "published", ifHead: null, changes: { put: put("Primera") } })
    const entered = deferred()
    const release = deferred()
    const head = store.workspace.history.head.bind(store.workspace.history)
    const reads = vi.spyOn(store.workspace.history, "head").mockImplementationOnce(async (options) => {
      const revision = await head(options)
      entered.resolve()
      await release.promise
      return revision
    })
    const live = createLiveTranslations({
      workspace: () => store.workspace,
      locales: ["en", "es"],
      sourceLocale: "en",
      snapshot: {},
      clientIds: [deploy.id],
    })
    const pending = live.refresh()
    await entered.promise
    const second = await store.workspace.history.commit({ ref: "published", ifHead: first.id, changes: { put: put("Segunda") } })
    const forced = live.refresh({ force: true })
    const alsoForced = live.refresh({ force: true })
    release.resolve()
    await Promise.all([pending, forced, alsoForced])
    expect(live.revision).toBe(second.id)
    await live.refresh()
    expect(live.messages("es")).toEqual({ [deploy.id]: compileMessage("Segunda") })
    expect(reads).toHaveBeenCalledTimes(2)
  })
})

function setup(store = memoryWorkspace()) {
  const context = new AsyncLocalStorage<object>()
  const hooks: ((event: object) => unknown)[] = []
  installI18nServer({ hooks: { hook: (_name, callback) => hooks.push(callback) } }, {
    config,
    messages: { en: {}, es: { [deploy.id]: compileMessage("Despliega tu agente"), [note.id]: compileMessage("Nota del servidor") } },
    current: () => context.getStore(),
    workspace: { name: "translations", open: () => store.workspace, clientIds: [deploy.id], interval: 0 },
  })
  const request = async <T>(run: () => T, language = "es"): Promise<T> => {
    const event = { req: new Request("http://app.test/", { headers: { "accept-language": language } }), context: {} }
    return await context.run(event, async () => {
      for (const hook of hooks) await hook(event)
      return run()
    })
  }
  return { store, request }
}

describe("translations in a Workspace", () => {
  it.each(["verified", "rejected"] as const)("keeps machine provenance when marking unchanged text %s", async (review) => {
    setup()
    const translations = useTranslations()
    const input = { locale: "es", source: deploy.message, translation: "Publica tu agente" }
    await translations.save({ ...input, review: "machine", by: "translator" })
    await translations.publish()
    if (review === "verified") {
      await translations.save({ ...input, review, by: "ana" })
      const verified = (await translations.list("es", { ref: "draft" }))[1]![deploy.id]!
      expect(verified).toMatchObject({ origin: "mt", review, by: "translator", verifiedBy: { by: "ana" } })
    }

    await translations.save({ ...input, translation: "", by: "ben" })
    const rejected = (await translations.list("es", { ref: "draft" }))[1]![deploy.id]!
    expect(rejected).toMatchObject({ origin: "mt", text: input.translation, review: "rejected", by: "translator", rejectedBy: { by: "ben" } })
    expect(rejected.verifiedBy).toBeUndefined()
  })

  it("keeps rejected text rejected when the same machine text is saved again", async () => {
    setup()
    const translations = useTranslations()
    const input = { locale: "es", source: deploy.message, translation: "Publica tu agente", review: "machine" } as const
    await translations.save({ ...input, by: "translator" })
    await translations.save({ ...input, translation: "", by: "ana" })
    const rejected = (await translations.list("es", { ref: "draft" }))[1]![deploy.id]!
    await translations.save({ ...input, by: "ben" })
    expect((await translations.list("es", { ref: "draft" }))[1]![deploy.id]).toEqual(rejected)
  })

  it("refuses verification of rejected text without committing a revision", async () => {
    const { store } = setup()
    const translations = useTranslations()
    const input = { locale: "es", source: deploy.message, translation: "Publica tu agente" }
    await translations.save({ ...input, review: "machine", by: "translator" })
    await translations.save({ ...input, translation: "", by: "ana" })
    const head = store.heads.get("draft")
    const rejected = (await translations.list("es", { ref: "draft" }))[1]![deploy.id]!

    await expect(translations.save({ ...input, review: "verified", by: "ben" })).rejects.toThrow(/rejected.*edit/)
    expect(store.heads.get("draft")).toBe(head)
    expect((await translations.list("es", { ref: "draft" }))[1]![deploy.id]).toEqual(rejected)
  })

  it.each(["Publica tu agente", "Despliega tu agente"])("edits rejected text to %s before verification", async (translation) => {
    setup()
    const translations = useTranslations()
    const input = { locale: "es", source: deploy.message, translation: "Publica tu agente" }
    await translations.save({ ...input, review: "machine", by: "translator" })
    await translations.save({ ...input, translation: "", by: "ana" })
    await translations.save({ ...input, translation, review: "edited", by: "ben" })
    const edited = (await translations.list("es", { ref: "draft" }))[1]![deploy.id]!
    expect(edited).toMatchObject({ origin: "human", text: translation, review: "edited", by: "ben" })
    expect(edited.rejectedBy).toBeUndefined()
    expect(edited.verifiedBy).toBeUndefined()

    await translations.save({ ...input, translation, review: "verified", by: "ana" })
    expect((await translations.list("es", { ref: "draft" }))[1]![deploy.id]).toMatchObject({ origin: "human", review: "verified", by: "ben", verifiedBy: { by: "ana" } })
  })

  it.each(["machine", "edited", "verified"] as const)("exchanges Diglot records with the file store and saves %s translations", async (review) => {
    const root = await mkdtemp(join(tmpdir(), "i18n-workspace-"))
    try {
      const { store, request } = setup()
      const source = "Payment received"
      const context = "checkout"
      const id = messageId(source, context)
      const original = record(source, "Pago recibido", context)
      const path = recordPath("es", original.hash)
      await writeRecord(root, "es", original)
      await store.workspace.history.commit({
        ref: "published",
        ifHead: null,
        changes: { put: { [path]: await readFile(join(root, path), "utf8") } },
      })
      const translations = useTranslations()
      expect((await translations.list("es"))[1]).toEqual({ [id]: original })
      const render = () => translate({ id, message: source })
      expect(await request(render)).toBe("Pago recibido")

      const [error, saved] = await translations.save({ locale: "es", source, context, translation: "Pago hecho", review, by: "ana" })
      expect(error).toBeUndefined()
      const view = await store.workspace.history.open(saved!.revision)
      const contents = await view.readFile(path, { encoding: "utf8" })
      const savedRecord = parseRecord(JSON.parse(contents))
      expect(savedRecord).toMatchObject({ hash: original.hash, salt: context, text: "Pago hecho", origin: review === "machine" ? "mt" : "human", review: review === "machine" ? "none" : review })
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), contents)
      expect(await readRecords(root, "es")).toEqual({ records: { [id]: savedRecord }, problems: [] })
      await translations.publish()
      expect(await request(render)).toBe("Pago hecho")

      await translations.save({ locale: "es", source, context, translation: "" })
      await translations.publish()
      expect((await translations.list("es"))[1]?.[id]).toMatchObject({ text: "Pago hecho", review: "rejected" })
      expect(await request(render)).toBe(source)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(["deleted", "malformed", "empty"])("replaces the detecting request's catalog when published records are %s", async (change) => {
    const { store, request } = setup()
    const extra = { hash: messageSegment("Live only message").hash, id: messageId("Live only message"), message: "Live only message" }
    const paths = [recordPath("es", deploy.hash), recordPath("es", extra.hash)]
    const first = await store.workspace.history.commit({
      ref: "published",
      ifHead: null,
      changes: { put: {
        [paths[0]!]: JSON.stringify(record(deploy.message, "Publica tu agente")),
        [paths[1]!]: JSON.stringify(record(extra.message, "Solo en vivo")),
      } },
    })
    const render = () => [translate(deploy), translate(extra), translate(note)]
    expect(await request(render)).toEqual(["Publica tu agente", "Solo en vivo", "Nota del servidor"])

    await store.workspace.history.commit({
      ref: "published",
      ifHead: first.id,
      changes: change === "deleted" ? { delete: paths } : { put: {
        [paths[0]!]: change === "malformed" ? "{" : JSON.stringify(record(deploy.message, "")),
        [paths[1]!]: change === "malformed" ? "{" : JSON.stringify(record(extra.message, "")),
      } },
    })
    const fallback = ["Despliega tu agente", extra.message, "Nota del servidor"]
    expect(await request(render), "the request that detects the revision removes stale messages").toEqual(fallback)
    expect(await request(render)).toEqual(fallback)
  })

  it("serves the build snapshot, hides drafts, and serves a publish on the next request", async () => {
    const { request } = setup()
    const translations = useTranslations()
    expect(await request(() => translate(deploy))).toBe("Despliega tu agente")
    expect(await request(() => translate(note))).toBe("Nota del servidor")
    expect(await translations.revision()).toBe("build")

    const [error, saved] = await translations.save({ locale: "ES", source: "Deploy your agent", translation: "Publica tu agente", by: "ana" })
    expect(error).toBeUndefined()
    expect(saved!.id).toBe(deploy.id)
    expect(await request(() => translate(deploy)), "a draft does not change the site").toBe("Despliega tu agente")
    const [, draft] = await translations.list("es", { ref: "draft" })
    expect(draft![deploy.id]).toMatchObject({ source: "Deploy your agent", text: "Publica tu agente", origin: "human", review: "edited", by: "ana" })
    expect((await translations.list("es"))[1]).toEqual({})

    expect(await translations.publish()).toEqual({ revision: expect.any(String), published: 1 })
    expect(await request(() => translate(deploy))).toBe("Publica tu agente")
    expect(await request(() => translate(note)), "a partial publish keeps other build translations").toBe("Nota del servidor")
    expect(await request(() => translate(deploy), "en")).toBe("Deploy your agent")
    expect(await translations.publish(), "nothing changed since the last publish").toMatchObject({ published: 0 })

    const [unknown] = await translations.save({ locale: "en", source: "Deploy your agent", translation: "x" })
    expect(unknown).toMatchObject({ code: "I18N_UNKNOWN_LOCALE" })
  })

  it("sends the browser only browser messages, with the revision as ETag", async () => {
    const { request } = setup()
    const translations = useTranslations()
    await translations.save({ locale: "es", source: "Deploy your agent", translation: "Publica tu agente" })
    await translations.save({ locale: "es", source: "Server only note", translation: "Nota del servidor" })
    const { revision } = await translations.publish()
    expect(await request(() => translate(note))).toBe("Nota del servidor")

    const response = await i18nCatalogResponse(new Request("http://app.test/_vitehub/i18n/es.json"))
    expect(response.headers.get("etag")).toBe(`"${revision}"`)
    expect(response.headers.get("cache-control")).toBe("no-cache")
    const body = await response.json() as { revision: string, messages: Record<string, unknown> }
    expect(body).toEqual({ revision, messages: { [deploy.id]: ["Publica tu agente"] } })

    const cached = await i18nCatalogResponse(new Request("http://app.test/_vitehub/i18n/es.json", { headers: { "if-none-match": `"${revision}"` } }))
    expect(cached.status).toBe(304)
    expect((await i18nCatalogResponse(new Request("http://app.test/_vitehub/i18n/fr.json"))).status).toBe(404)
  })

  it("keeps its translations when the Workspace cannot be read", async () => {
    const { store, request } = setup()
    const translations = useTranslations()
    await translations.save({ locale: "es", source: "Deploy your agent", translation: "Publica tu agente" })
    await translations.publish()
    store.fail(true)
    const errors: unknown[] = []
    const log = console.error
    console.error = (...args: unknown[]) => errors.push(args[0])
    try {
      expect(await request(() => translate(deploy))).toBe("Publica tu agente")
    }
    finally {
      console.error = log
    }
    expect(errors).toEqual([expect.stringContaining("could not read the Workspace \"translations\"")])
  })

  it.each(["list", "readFile"] as const)("keeps every catalog and the revision when a revision %s fails", async (method) => {
    const store = memoryWorkspace()
    const put = (translation: string) => Object.fromEntries(["es", "fr"].map(locale => [
      recordPath(locale, deploy.hash), JSON.stringify(record(deploy.message, translation)),
    ]))
    const first = await store.workspace.history.commit({ ref: "published", ifHead: null, changes: { put: put("Primera") } })
    const onError = vi.fn()
    const live = createLiveTranslations({
      workspace: () => store.workspace,
      locales: ["en", "es", "fr"],
      sourceLocale: "en",
      snapshot: {},
      clientIds: [deploy.id],
      interval: 0,
      onError,
    })
    await live.refresh()
    expect(live.revision).toBe(first.id)
    const catalogs = [live.messages("es"), live.messages("fr"), live.clientMessages("es"), live.clientMessages("fr")]
    const second = await store.workspace.history.commit({ ref: "published", ifHead: first.id, changes: { put: put("Segunda") } })
    const error = new Error("store revision read failed")
    const open = store.workspace.history.open.bind(store.workspace.history)
    const failing = vi.spyOn(store.workspace.history, "open").mockImplementationOnce(async (id) => {
      const view = await open(id)
      vi.spyOn(view, method).mockRejectedValueOnce(error)
      return view
    })
    try {
      await live.refresh()
      expect(live.revision).toBe(first.id)
      expect([live.messages("es"), live.messages("fr"), live.clientMessages("es"), live.clientMessages("fr")]).toEqual(catalogs)
      expect(onError).toHaveBeenCalledExactlyOnceWith(error)
    }
    finally {
      failing.mockRestore()
    }
    await live.refresh()
    expect(live.revision).toBe(second.id)
    expect(live.messages("es")[deploy.id]).toEqual(compileMessage("Segunda"))
    expect(live.clientMessages("fr")[deploy.id]).toEqual(compileMessage("Segunda"))
  })
})

describe("useTranslations() without a Workspace", () => {
  it("throws a config error", () => {
    installI18nServer({ hooks: { hook: () => undefined } }, { config, messages: {}, current: () => undefined })
    expect(() => useTranslations()).toThrow(expect.objectContaining({ code: "I18N_NO_WORKSPACE" }))
  })
})

describe("the browser with a Workspace", () => {
  it.each(["Despliega tu agente", deploy.message])("restores the browser fallback %s after a translation is cleared", async (fallback) => {
    setup()
    const translations = useTranslations()
    await translations.save({ locale: "es", source: deploy.message, translation: "Publica tu agente" })
    await translations.publish()
    vi.stubGlobal("document", { cookie: "", documentElement: { lang: "en" } })
    vi.stubGlobal("fetch", (url: string) => i18nCatalogResponse(new Request(`http://app.test${url}`)))
    try {
      configureI18n({
        ...config,
        live: "/_vitehub/i18n",
        catalogs: { es: async () => ({ messages: { [deploy.id]: compileMessage(fallback) } }) },
      })
      await setLocale("es")
      expect(getI18n()._(deploy)).toBe("Publica tu agente")

      await translations.save({ locale: "es", source: deploy.message, translation: "" })
      const { revision } = await translations.publish()
      const response = await i18nCatalogResponse(new Request("http://app.test/_vitehub/i18n/es.json"))
      expect(await response.json()).toEqual({ revision, messages: {} })
      await setLocale("es")
      expect(getI18n()._(deploy)).toBe(fallback)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it("reports a superseded selection while its live catalog is still loading", async () => {
    const pending = deferred()
    const page = { cookie: "", documentElement: { lang: "en" } }
    vi.stubGlobal("document", page)
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/es.json")) await pending.promise
      return Response.json({ revision: "rev-2", messages: { [deploy.id]: ["Publica tu agente"] } })
    })
    try {
      configureI18n({ ...config, live: "/_vitehub/i18n", catalogs: {} })
      const earlier = setLocale("es")
      expect(await setLocale("en")).toEqual([undefined, "en"])
      pending.resolve()
      const [error, locale] = await earlier
      expect(error).toMatchObject({ code: "I18N_LOCALE_SUPERSEDED" })
      expect(locale).toBeUndefined()
      expect(getI18n().locale).toBe("en")
      expect(page.documentElement.lang).toBe("en")
      expect(page.cookie).toContain("locale=en;")
    }
    finally {
      pending.resolve()
      vi.unstubAllGlobals()
    }
  })

  it("puts published translations over the build catalog, and keeps the build catalog when the route fails", async () => {
    const requests: string[] = []
    let routeUp = true
    vi.stubGlobal("document", { cookie: "", documentElement: { lang: "en" } })
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(url)
      if (!routeUp) throw new TypeError("offline")
      return Response.json({ revision: "rev-2", messages: { [deploy.id]: ["Publica tu agente"] } })
    })
    try {
      configureI18n({
        ...config,
        live: "/_vitehub/i18n",
        catalogs: { en: async () => ({ messages: {} }), es: async () => ({ messages: { [deploy.id]: ["Despliega tu agente"], [note.id]: ["Nota"] } }) },
      })
      await setLocale("es")
      expect(requests).toEqual(["/_vitehub/i18n/es.json"])
      expect(getI18n()._(deploy)).toBe("Publica tu agente")
      expect(getI18n()._(note)).toBe("Nota")
      routeUp = false
      await setLocale("en")
      await setLocale("es")
      expect(getI18n()._(deploy)).toBe("Despliega tu agente")
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("missing translations for Agents", () => {
  const richTextChoices = (count: number, branching: boolean) => Array.from({ length: count }, (_, index) =>
    `{choice${index}, select, one {${branching ? "<0/>" : "<0/><1/>"}} other {${branching ? "<1/>" : "<0/><1/>"}}}`).join(" ")

  it.each(["source", "translation", "both"] as const)("bounds rich-text branch expansion in the %s", async (side) => {
    const store = memoryWorkspace()
    installI18nServer({ hooks: { hook: () => undefined } }, {
      config,
      messages: {},
      current: () => undefined,
      workspace: { name: "translations", open: () => store.workspace, clientIds: null, interval: 0 },
    })
    const [error] = await useTranslations().save({ locale: "es", source: richTextChoices(40, side !== "translation"), translation: richTextChoices(40, side !== "source") })
    expect(error).toMatchObject({ code: "I18N_INVALID_TRANSLATION", why: expect.stringContaining("256") })
    expect(store.heads.size).toBe(0)
  })

  it.each([
    ["Click <0>here</0>", "Haz clic <0>aquí"],
    ["Click <0>here</0>", "Haz clic aquí</0>"],
    ["Click <0>here</0>", "Haz clic </0>aquí<0>"],
    ["Click <0>here</0>", "Haz clic <0>aquí</0></0>"],
    ["Click <0>here</0>", "Haz clic <0>aquí</0> <0>ahora</0>"],
    ["Click <0>here</0> or <0>there</0>", "Haz clic <0>aquí</0>"],
    ["Click <0>here</0>", "Haz clic <0/>aquí"],
    ["Click <0><1>here</1></0>", "Haz clic <0><1>aquí</0></1>"],
    ["{count, plural, one {<0>Item</0>} other {<0>Items</0>}}", "{count, plural, one {<0>Artículo} other {Artículos</0>}}"],
    ["{count, plural, one {<0>Item</0>} other {<0>Items</0>}}", "{count, plural, one {<0>Artículo</0>} other {Artículos}}"],
  ])("refuses malformed or changed rich-text tags: %s → %s", async (source, translation) => {
    const store = memoryWorkspace()
    installI18nServer({ hooks: { hook: () => undefined } }, {
      config,
      messages: {},
      current: () => undefined,
      workspace: { name: "translations", open: () => store.workspace, clientIds: null, interval: 0 },
    })
    const [error] = await useTranslations().save({ locale: "es", source, translation })
    expect(error).toMatchObject({ code: "I18N_INVALID_TRANSLATION" })
    expect(store.heads.size).toBe(0)
  })

  it.each([
    ["Click <0>here</0> or <1>there</1>", "Haz clic <1>allí</1> o <0>aquí</0>"],
    ["Hello <0>{name}</0><1/>", "Hola <0>{name}</0><1/>"],
    ["Click <0><1>here</1></0>", "Haz clic <0><1>aquí</1></0>"],
    ["{count, plural, one {<0>Item</0>} other {<0>Items</0>}}", "{count, plural, one {<0>Artículo</0>} many {<0>Artículos</0>} other {<0>Artículos</0>}}"],
    ["<0>{count, plural, one {Item} other {Items}}</0>", "{count, plural, one {<0>Artículo} other {<0>Artículos}}</0>"],
    [richTextChoices(8, true), richTextChoices(8, true)],
    [richTextChoices(40, false), richTextChoices(40, false)],
  ])("saves valid rich-text tags across ICU branches: %s → %s", async (source, translation) => {
    const store = memoryWorkspace()
    installI18nServer({ hooks: { hook: () => undefined } }, {
      config,
      messages: {},
      current: () => undefined,
      workspace: { name: "translations", open: () => store.workspace, clientIds: null, interval: 0 },
    })
    const translations = useTranslations()
    const [error] = await translations.save({ locale: "es", source, translation })
    expect(error).toBeUndefined()
    const [, drafts] = await translations.list("es", { ref: "draft" })
    expect(drafts).toMatchObject({ [messageId(source)]: { source, text: translation } })
  })

  it.each([
    ["Hello {name}", "Hola {name}"],
    ["Click <0>here</0>", "Haz clic <0>aquí</0>"],
    ["{count, plural, one {Item} other {Items}}", "{count, plural, one {Artículo} other {Artículos}}"],
  ])("clears translations with ICU arguments or rich-text tags: %s", async (source, translation) => {
    const store = memoryWorkspace()
    installI18nServer({ hooks: { hook: () => undefined } }, {
      config,
      messages: {},
      current: () => undefined,
      workspace: { name: "translations", open: () => store.workspace, clientIds: null, interval: 0 },
    })
    const translations = useTranslations()
    expect((await translations.save({ locale: "es", source, translation }))[0]).toBeUndefined()
    await translations.publish()
    expect((await translations.save({ locale: "es", source, translation: "" }))[0]).toBeUndefined()
    await translations.publish()
    const [, published] = await translations.list("es")
    expect(published?.[messageId(source)]).toMatchObject({ text: translation, review: "rejected" })
  })

  it("does not count rejected records as translations", async () => {
    const store = memoryWorkspace()
    installI18nServer({ hooks: { hook: () => undefined } }, {
      config,
      messages: {},
      current: () => undefined,
      workspace: {
        name: "translations",
        open: () => store.workspace,
        clientIds: null,
        interval: 0,
        sources: { [deploy.id]: { message: deploy.message, hash: deploy.hash, origins: [] } },
      },
    })
    const translations = useTranslations()
    await translations.save({ locale: "es", source: deploy.message, translation: "Despliega tu agente" })
    await translations.publish()
    await translations.save({ locale: "es", source: deploy.message, translation: "" })
    expect(await translations.status()).toEqual([{ locale: "es", messages: 1, published: 1, drafted: 0, missing: 0 }])
    expect((await translations.missing("es"))[1]?.total).toBe(0)
    await translations.publish()
    expect(await translations.status()).toEqual([{ locale: "es", messages: 1, published: 0, drafted: 0, missing: 1 }])
    expect((await translations.missing("es"))[1]?.items).toEqual([{ id: deploy.id, source: deploy.message, origins: [] }])
  })

  it("lists what a locale lacks, with the old translation of a changed message, and refuses broken translations", async () => {
    const store = memoryWorkspace()
    const sources = {
      [messageId("Search all agents")]: { message: "Search all agents", hash: messageSegment("Search all agents").hash, origins: ["src/App.vue:4"] },
      [deploy.id]: { message: deploy.message, hash: deploy.hash, origins: ["src/App.vue:3"] },
      [messageId("{count, plural, one {Item} other {Items}}")]: { message: "{count, plural, one {Item} other {Items}}", hash: messageSegment("{count, plural, one {Item} other {Items}}").hash, origins: ["src/List.vue:2"] },
    }
    installI18nServer({ hooks: { hook: () => undefined } }, {
      config,
      messages: {},
      current: () => undefined,
      workspace: { name: "translations", open: () => store.workspace, clientIds: null, interval: 0, sources },
    })
    const translations = useTranslations()
    await translations.save({ locale: "es", source: "Search agents", translation: "Buscar agentes" })
    await translations.publish()
    await translations.save({ locale: "es", source: deploy.message, translation: "Despliega tu agente" })

    expect(await translations.status()).toEqual([{ locale: "es", messages: 3, published: 0, drafted: 1, missing: 2 }])
    const [, page] = await translations.missing("es", { limit: 1 })
    expect(page!.total).toBe(2)
    const [, next] = await translations.missing("es", { cursor: page!.cursor! })
    const items = [...page!.items, ...next!.items]
    expect(items).toContainEqual({ id: messageId("Search all agents"), source: "Search all agents", origins: ["src/App.vue:4"], previous: { source: "Search agents", translation: "Buscar agentes" } })
    expect(next!.cursor).toBeNull()

    const plural = "{count, plural, one {Item} other {Items}}"
    expect((await translations.save({ locale: "es", source: plural, translation: "{count, plural, one {Artículo} other {Artículos}}" }))[0]).toBeUndefined()
    const [missingArgument] = await translations.save({ locale: "es", source: "Hello {name}", translation: "Hola" })
    expect(missingArgument).toMatchObject({ code: "I18N_INVALID_TRANSLATION", why: expect.stringContaining("{name}") })
    const [broken] = await translations.save({ locale: "es", source: plural, translation: "{count, plural, one {Artículo}" })
    expect(broken).toMatchObject({ code: "I18N_INVALID_TRANSLATION", why: expect.stringContaining("not valid ICU") })
  })
})
