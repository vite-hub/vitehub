import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import viteHubConsoleHostedComments from "../src/console/runtime/hosted-comments-loader.ts"
import { hostedCommentsKeys, hostedCommentsLoader, withHostedComments } from "../src/console/runtime/server/hosted-comments.ts"
import { consoleTestKey } from "./support/console-signature.ts"

const app = "https://cocina.example.com"
const key = await consoleTestKey("CONSOLE_0A1B2C3D")
const page = "<!doctype html><html><head></head><body><main>Alioli</main></body></html>"

function html(body = page, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } })
}

async function served(path: string, response: Response = html(), init: RequestInit = {}): Promise<string> {
  return await withHostedComments(new Request(`${app}${path}`, init), response).text()
}

beforeEach(() => {
  for (const [name, value] of Object.entries(key.env)) vi.stubEnv(name, value)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("the Hosted Comments pill of an app without Comments", () => {
  it("adds the loader with the Console keys of the app to its pages", async () => {
    const body = await served("/recetas/alioli-de-ajo-negro?vitehub")
    expect(body).toBe(page.replace("</body>", `${hostedCommentsLoader("https://console.vitehub.dev", [key.publicKey])}</body>`))
    expect(body).toContain("\"https://console.vitehub.dev/hosted-comments.js\"")
    expect(body).toContain(JSON.stringify(key.publicKey))
    vi.stubGlobal("__VITEHUB_CONSOLE_URL__", "https://console.example.org")
    expect(await served("/")).toContain("\"https://console.example.org/hosted-comments.js\"")
  })

  it("gives the loader the nonce of the page policy and keeps the cache policy", async () => {
    const response = withHostedComments(new Request(`${app}/`), html(page, { "cache-control": "public, max-age=60", "content-security-policy": "script-src 'nonce-abc123' 'strict-dynamic'" }))
    expect(response.headers.get("cache-control")).toBe("public, max-age=60")
    expect(await response.text()).toContain("<script data-vitehub-hosted-comments nonce=\"abc123\" data-vitehub-page-tools>")
  })

  it("adds no loader to an app without Console keys, to other responses, or below /_vitehub", async () => {
    expect(await served("/_vitehub/site")).toBe(page)
    expect(await served("/", new Response(page, { headers: { "content-type": "application/json" } }))).toBe(page)
    expect(await served("/", html(page), { headers: { "x-forwarded-host": "localhost:3000" } })).toBe(page)
    expect(await withHostedComments(new Request("http://localhost:3000/"), html()).text()).toBe(page)
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: app })
    expect(await withHostedComments(new Request("https://abc-cocina.example.com/"), html()).text()).toBe(page)
    vi.stubEnv("VITEHUB_CONSOLE_KEY_CONSOLE_0A1B2C3D", "")
    expect(await served("/")).toBe(page)
  })

  it("adds the loader to a prerendered page, and only once", async () => {
    const prerendered = await withHostedComments(new Request("http://localhost/recetas", { headers: { "x-nitro-prerender": "/recetas" } }), html()).text()
    expect(prerendered).toContain("data-vitehub-hosted-comments")
    expect(await served("/recetas", html(prerendered))).toBe(prerendered)
  })

  it("reads only well-formed Console keys", () => {
    expect(hostedCommentsKeys({ ...key.env, OTHER: "x" })).toEqual([key.publicKey])
    expect(hostedCommentsKeys({ VITEHUB_CONSOLE_KEY_CONSOLE_0A1B2C3D: "not-a-key" })).toEqual([])
    expect(hostedCommentsKeys({})).toEqual([])
  })

  it("wraps the fetch of the Nitro app and changes only HTML pages", async () => {
    const nitroApp = { fetch: async (request: Request) => request.url.endsWith(".json") ? Response.json({ ok: true }) : html() }
    viteHubConsoleHostedComments(nitroApp)
    expect(await (await nitroApp.fetch(new Request(`${app}/`))).text()).toContain("data-vitehub-hosted-comments")
    expect(await (await nitroApp.fetch(new Request(`${app}/data.json`))).json()).toEqual({ ok: true })
  })
})
