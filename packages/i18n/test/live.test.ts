import { AsyncLocalStorage } from "node:async_hooks"

import { compileMessage } from "@lingui/message-utils/compileMessage"
import { describe, expect, it, vi } from "vitest"

import { createLiveTranslations, readRevisionRecords } from "../src/live.ts"
import { resolveI18nLocaleConfig } from "../src/locales.ts"
import { recordPath } from "../src/record-format.ts"
import { messageId } from "../src/records.ts"
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
          list: async folder => Object.keys(files).filter(path => path.startsWith(`${folder}/`)).map(path => ({ path, type: "file" })),
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
const deploy = { id: messageId("Deploy your agent"), message: "Deploy your agent" }
const note = { id: messageId("Server only note"), message: "Server only note" }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => resolve = done)
  return { promise, resolve }
}

describe("Workspace records", () => {
  it("publishes valid translations alongside invalid ICU in later revisions", async () => {
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
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      let head: string | null = null
      for (const translation of ["Primera", "Segunda"]) {
        const revision = await store.workspace.history.commit({
          ref: "published",
          ifHead: head,
          changes: { put: {
            [recordPath("es", note.id)]: JSON.stringify({ source: note.message, translation: "{count, plural," }),
            [recordPath("es", deploy.id)]: JSON.stringify({ source: deploy.message, translation }),
          } },
        })
        head = revision.id
        await live.refresh()
        expect(live.revision).toBe(revision.id)
        // Lingui logs invalid ICU and keeps it as literal text; other records still become live.
        const messages = { [note.id]: ["{count, plural,"], [deploy.id]: compileMessage(translation) }
        expect(live.messages("es")).toEqual(messages)
        expect(live.clientMessages("es")).toEqual(messages)
      }
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Message: {count, plural,"))
    }
    finally {
      log.mockRestore()
    }
  })

  it.each([undefined, "checkout"])("skips records whose source and context %s do not match their filename", async (context) => {
    const store = memoryWorkspace()
    const valid = { source: deploy.message, ...(context === undefined ? {} : { context }), translation: "Publica tu agente" }
    const id = messageId(valid.source, valid.context)
    const revision = await store.workspace.history.commit({
      ref: "published",
      ifHead: null,
      changes: { put: {
        [recordPath("es", id)]: JSON.stringify(valid),
        [recordPath("es", note.id)]: JSON.stringify({ source: deploy.message, context, translation: "Wrong message" }),
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
        [recordPath("es", note.id)]: "{",
        [recordPath("es", deploy.id)]: JSON.stringify({ source: deploy.message, translation: "Primera" }),
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
      changes: { put: { [recordPath("es", deploy.id)]: JSON.stringify({ source: deploy.message, translation: "Segunda" }) } },
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
    const put = (translation: string) => ({ [recordPath("es", deploy.id)]: JSON.stringify({ source: deploy.message, translation }) })
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
  it.each(["deleted", "malformed", "empty"])("replaces the detecting request's catalog when published records are %s", async (change) => {
    const { store, request } = setup()
    const extra = { id: messageId("Live only message"), message: "Live only message" }
    const paths = [recordPath("es", deploy.id), recordPath("es", extra.id)]
    const first = await store.workspace.history.commit({
      ref: "published",
      ifHead: null,
      changes: { put: {
        [paths[0]!]: JSON.stringify({ source: deploy.message, translation: "Publica tu agente" }),
        [paths[1]!]: JSON.stringify({ source: extra.message, translation: "Solo en vivo" }),
      } },
    })
    const render = () => [translate(deploy), translate(extra), translate(note)]
    expect(await request(render)).toEqual(["Publica tu agente", "Solo en vivo", "Nota del servidor"])

    await store.workspace.history.commit({
      ref: "published",
      ifHead: first.id,
      changes: change === "deleted" ? { delete: paths } : { put: {
        [paths[0]!]: change === "malformed" ? "{" : JSON.stringify({ source: deploy.message, translation: "" }),
        [paths[1]!]: change === "malformed" ? "{" : JSON.stringify({ source: extra.message, translation: "" }),
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
    expect(draft![deploy.id]).toMatchObject({ source: "Deploy your agent", translation: "Publica tu agente", review: "edited", by: "ana" })
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
      recordPath(locale, deploy.id), JSON.stringify({ source: deploy.message, translation }),
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
