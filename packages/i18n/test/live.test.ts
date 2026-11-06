import { AsyncLocalStorage } from "node:async_hooks"

import { compileMessage } from "@lingui/message-utils/compileMessage"
import { describe, expect, it, vi } from "vitest"

import { resolveI18nLocaleConfig } from "../src/locales.ts"
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
        revisions.set(id, { ...base, ...changes.put })
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

function setup(store = memoryWorkspace()) {
  const context = new AsyncLocalStorage<object>()
  const hooks: ((event: object) => unknown)[] = []
  installI18nServer({ hooks: { hook: (_name, callback) => hooks.push(callback) } }, {
    config,
    messages: { en: {}, es: { [deploy.id]: compileMessage("Despliega tu agente") } },
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
  it("serves the build snapshot, hides drafts, and serves a publish on the next request", async () => {
    const { request } = setup()
    const translations = useTranslations()
    expect(await request(() => translate(deploy))).toBe("Despliega tu agente")
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
})

describe("useTranslations() without a Workspace", () => {
  it("throws a config error", () => {
    installI18nServer({ hooks: { hook: () => undefined } }, { config, messages: {}, current: () => undefined })
    expect(() => useTranslations()).toThrow(expect.objectContaining({ code: "I18N_NO_WORKSPACE" }))
  })
})

describe("the browser with a Workspace", () => {
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
