import { createContentPreview, defineContentPreviewPlugin } from "../../content/src/preview.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDocuments } from "../src/console/runtime/server/documents.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { siteAccessRoute, siteActionRoute } from "../src/console/runtime/server/site.ts"
import { installViteHubConsoleOperations } from "./support/console-operations.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { cookieJar, siteActionBrowser } from "./support/site-token.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleDocumentActions } from "../src/console/runtime/server/documents.ts"
import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"

const origin = "http://localhost:5173"
const ada: ConsoleCallerUser = { email: "Ada@Example.com", id: "console-ada", name: "Ada" }
const adaClaims = { sub: "console-ada", name: "Ada", email: "ada@example.com" }
const key = await consoleTestKey("CONSOLE_PREVIEW")
const root = "/work/console-site-preview"
const target = { collection: "posts", id: "hello", section: "content" }

function contentSection(url = "/blog/hello") {
  const preview = createContentPreview({ enabled: true })
  const users: unknown[] = []
  const actions = {
    collections: () => [],
    mediaAccess: () => ({ manage: false, read: true, write: false }),
    get: (input: unknown, context: { user: unknown }) => {
      users.push(context.user)
      return { collection: "posts", id: Reflect.get(Object(input), "id"), url }
    },
    preview: async (input: unknown, context: { user: unknown }) => {
      users.push(context.user)
      const { token } = await preview.sign({ collection: String(Reflect.get(Object(input), "collection")), id: String(Reflect.get(Object(input), "id")) })
      return { parameter: "vitehub-content-preview", token, expiresAt: new Date().toISOString() }
    },
  } as unknown as ConsoleDocumentActions
  installConsoleDocuments(root, { content: { actions: () => actions, load: async () => ({}) } })
  return { preview, users }
}

async function operation(input: Record<string, unknown>, rpc = `${origin}/_vitehub/rpc`): Promise<Response> {
  return await handleConsoleRpcRequest(await signedRpcRequest({ caller: { user: ada, via: "console" }, input, key: key.key, operation: "documents.preview", url: rpc }))
}

function previewForm(page: string): { action: string | undefined, value: string | undefined } {
  return {
    action: /<form method="post" action="([^"]+)">/.exec(page)?.[1]?.replaceAll("&#38;", "&"),
    value: /name="vitehub-content-preview" value="([^"]+)"/.exec(page)?.[1]?.replaceAll("&#34;", "\""),
  }
}

beforeEach(async () => {
  for (const [name, value] of Object.entries(key.env)) vi.stubEnv(name, value)
  vi.stubEnv("VITEHUB_CONTENT_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
  installConsoleSections(root, ["content"])
  installConsoleAccess({ mode: "token", authorize: () => true })
  await installViteHubConsoleOperations()
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  vi.unstubAllEnvs()
})

describe("Content preview with a signed Site access token", () => {
  it("checks the document as the person, then opens its draft: the form posts a frame token that the Content preview plugin accepts", async () => {
    const { preview, users } = contentSection()
    expect(await operationRpcResponseResult(await operation(target))).toMatchObject({ ok: true, value: { path: "/blog/hello" } })

    const visit = await siteActionBrowser(siteActionRoute, origin)
    const page = await visit.open(await visit.token({ key: key.key, kind: "preview", target, claims: { ...adaClaims, path: "/blog/hello" } }))
    expect(page.status).toBe(200)
    expect(page.headers.get("cache-control")).toBe("no-store")
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[\w+/=]+'; form-action 'self'/)
    expect(page.headers.getSetCookie()).toEqual([expect.stringContaining(`__Host-vitehub-site-state-${visit.intent}=; Path=/; Max-Age=0`)])
    const { action, value } = previewForm(await page.text())
    expect(action).toBe(`${origin}/blog/hello?vitehub-content-preview=`)
    expect(users).toEqual([expect.objectContaining({ id: "console-ada" }), expect.objectContaining({ id: "console-ada", email: "ada@example.com" })])

    const nitroApp: { fetch: (request: Request) => Promise<Response>, hooks: { hook(): void } } = {
      fetch: async () => Response.json(preview.frame() ?? null),
      hooks: { hook() {} },
    }
    defineContentPreviewPlugin({ preview })(nitroApp)
    const rendered = await nitroApp.fetch(new Request(action!, {
      body: new URLSearchParams({ "vitehub-content-preview": value! }),
      headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:5173", origin, "sec-fetch-site": "same-origin" },
      method: "POST",
    }))
    expect(await rendered.json()).toEqual({ collection: "posts", id: "hello" })
  })

  it("redeems two pending previews without clearing each other's state or regular Site access state", async () => {
    contentSection()
    const site = await siteAccessRoute.fetch(new Request(`${origin}/_vitehub/site`))
    const siteState = cookieJar("", site)
    const first = await siteActionBrowser(siteAccessRoute, origin, siteState)
    const second = await siteActionBrowser(siteAccessRoute, origin, first.cookie)
    const input = { key: key.key, kind: "preview" as const, target, claims: adaClaims }
    const firstToken = await first.token(input)
    const swapped = await second.open(firstToken, second.cookie)
    expect(swapped.status).toBe(401)
    expect(await swapped.text()).toContain("(SITE_TOKEN_STATE)")
    const firstPage = await first.open(firstToken, second.cookie)
    expect(firstPage.status).toBe(200)
    const afterFirst = cookieJar(second.cookie, firstPage)
    const secondPage = await second.open(await second.token(input), afterFirst)
    expect(secondPage.status).toBe(200)
    expect(cookieJar(afterFirst, secondPage)).toBe(siteState)
    expect((await first.open(firstToken, afterFirst)).status).toBe(401)
  })

  it("answers the path below the base of an app that is mounted under a path, and opens the page under that base", async () => {
    contentSection(`${origin}/portal/blog/hello?draft=1`)
    expect(await operationRpcResponseResult(await operation(target, `${origin}/portal/_vitehub/rpc`))).toMatchObject({ value: { path: "/blog/hello?draft=1" } })
    const app = `${origin}/portal`
    const visit = await siteActionBrowser(siteActionRoute, app)
    const page = await visit.open(await visit.token({ key: key.key, kind: "preview", target, claims: { ...adaClaims, aud: app, path: "/blog/hello?draft=1" } }))
    expect(previewForm(await page.text()).action).toBe(`${origin}/portal/blog/hello?draft=1&vitehub-content-preview=`)
  })

  it("refuses a document whose page is on another site", async () => {
    contentSection("https://elsewhere.example/blog/hello")
    const response = await operation(target)
    expect(response.status).toBe(409)
    expect(await operationRpcResponseResult(response)).toMatchObject({ message: "The page URL of the document is not on this app." })
  })

  it("refuses a preview token without a document, and a preview token in the Site access cookie flow", async () => {
    contentSection()
    const visit = await siteActionBrowser(siteAccessRoute, origin)
    const empty = await visit.open(await visit.token({ key: key.key, kind: "preview", claims: adaClaims }))
    expect(empty.status).toBe(401)
    expect(await empty.text()).toContain("The preview token names no document.")
    expect(empty.headers.getSetCookie().some(line => line.startsWith("__Host-vitehub-site="))).toBe(false)
  })
})
