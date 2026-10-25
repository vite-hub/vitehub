// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { injectLoader, loaderTag, loaderUrl, mountPath, renderOverlayMiddleware } from "../src/overlay.ts"
import { hubComments } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-comments-overlay-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), "{}")
  await mkdir(join(root, "server"))
  await writeFile(join(root, "server", "comments.ts"), "export default {}\n")
  return root
}

type ConfigHook = (config: Record<string, unknown>) => Promise<void>
const configHook = (plugin: ReturnType<typeof hubComments>) => (plugin.config && "handler" in plugin.config ? plugin.config.handler : plugin.config) as unknown as ConfigHook
const indexHtml = (plugin: ReturnType<typeof hubComments>) => {
  const hook = plugin.transformIndexHtml
  return (hook && "handler" in hook ? hook.handler : hook) as unknown as (html: string) => string
}
const assets = { dir: "/dist/comments-overlay", version: "abc123" }

describe("the overlay loader tag", () => {
  it("builds the URL below the app mount, with the version and the page filter", () => {
    expect(mountPath(undefined)).toBe("")
    expect(mountPath("/")).toBe("")
    expect(mountPath("./")).toBe("")
    expect(mountPath("/portal/")).toBe("/portal")
    expect(mountPath("https://cdn.example.com/app/")).toBe("/app")
    expect(mountPath("//evil.example.com/")).toBe("")
    expect(loaderUrl("", assets)).toBe("/_vitehub/comments/loader.js?v=abc123")
    const filtered = loaderUrl("/portal", assets, { exclude: ["/admin/**"], paths: ["/docs/**"] })
    expect(filtered.startsWith("/portal/_vitehub/comments/loader.js?v=abc123&o=")).toBe(true)
    expect(JSON.parse(decodeURIComponent(filtered.split("&o=")[1]!))).toEqual({ exclude: ["/admin/**"], paths: ["/docs/**"] })
    expect(loaderTag(filtered)).toBe(`<script type="module" src="${filtered.replaceAll("&", "&amp;")}"></script>`)
  })

  it("goes before the last </body>, once", () => {
    const tag = loaderTag(loaderUrl("", assets))
    const html = "<html><body><main>Hi</main></body></html>"
    const once = injectLoader(html, tag)
    expect(once).toBe(`<html><body><main>Hi</main>${tag}</body></html>`)
    expect(injectLoader(once, tag)).toBe(once)
    expect(injectLoader("<p>fragment</p>", tag)).toBe(`<p>fragment</p>${tag}`)
    expect(injectLoader("<body>a</body><script>'</body>'</script></body>", tag)).toMatch(/<\/script><script type="module".*<\/body>$/)
  })
})

describe("the Nitro middleware", () => {
  async function middleware() {
    const source = renderOverlayMiddleware(loaderTag(loaderUrl("", assets)))
    const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    return (await import(/* @vite-ignore */ url)).default as (event: unknown, next?: () => unknown) => Promise<unknown>
  }
  const event = (path = "/", method = "GET", type = "") => ({ req: { method, url: `http://localhost${path}` }, res: { headers: new Headers(type ? { "content-type": type } : {}) } })

  it("adds the loader to HTML responses and strings, and leaves the rest alone", async () => {
    const inject = await middleware()
    const html = new Response("<html><body>Hi</body></html>", { headers: { "content-length": "28", "content-type": "text/html; charset=utf-8" }, status: 201 })
    const injected = await inject(event(), async () => html) as Response
    expect(injected.status).toBe(201)
    expect(injected.headers.has("content-length")).toBe(false)
    expect(await injected.text()).toContain("/_vitehub/comments/loader.js?v=abc123")
    expect(await inject(event("/", "GET", "text/html"), async () => "<main>Hi</main>")).toContain("loader.js")
    expect(await inject(event(), async () => "<html><body>Hi</body></html>")).toContain("loader.js")
    const json = new Response("{}", { headers: { "content-type": "application/json" } })
    expect(await inject(event(), async () => json)).toBe(json)
    expect(await inject(event("/", "GET", "text/plain"), async () => "plain")).toBe("plain")
    expect(await inject(event("/", "POST"), async () => "<body></body>")).toBe("<body></body>")
    // The Console page is HTML too, and never gets the overlay.
    expect(await inject(event("/_vitehub/content"), async () => "<body></body>")).toBe("<body></body>")
    expect(await inject(event("/_vitehub"), async () => "<body></body>")).toBe("<body></body>")
    expect(await inject(event("/portal/_vitehub"), async () => "<body></body>")).toBe("<body></body>")
    expect(await inject(event("/_vitehubs"), async () => "<body></body>")).toContain("loader.js")
    expect(await inject(event(), async () => ({ ok: true }))).toEqual({ ok: true })
  })

  it("does nothing where the host calls it without next", async () => {
    expect(await (await middleware())({})).toBeUndefined()
  })
})

describe("hubComments overlay", () => {
  it("injects the loader into index.html, and into nothing without the assets, the file, or when it is off", async () => {
    const root = await project()
    const plugin = hubComments({ overlayAssets: assets })
    await configHook(plugin)({ root })
    ;(plugin.configResolved as unknown as (config: { base: string, plugins: unknown[] }) => void)({ base: "/", plugins: [{ name: "@vite-hub/database/vite" }] })
    expect(indexHtml(plugin)("<body>Hi</body>")).toBe(`<body>Hi<script type="module" src="/_vitehub/comments/loader.js?v=abc123"></script></body>`)

    const off = hubComments({ overlay: false, overlayAssets: assets })
    await configHook(off)({ root })
    expect(indexHtml(off)("<body>Hi</body>")).toBe("<body>Hi</body>")
    const bare = hubComments()
    await configHook(bare)({ root })
    expect(indexHtml(bare)("<body>Hi</body>")).toBe("<body>Hi</body>")

    const empty = await mkdtemp(join(tmpdir(), "vitehub-comments-overlay-"))
    roots.push(empty)
    await writeFile(join(empty, "package.json"), "{}")
    const without = hubComments({ overlayAssets: assets })
    await configHook(without)({ root: empty })
    expect(indexHtml(without)("<body>Hi</body>")).toBe("<body>Hi</body>")
  })

  it("serves the bundle from Nitro with a long cache and adds the middleware and the render hook", async () => {
    const root = await project()
    const plugin = hubComments({ overlay: { exclude: ["/admin/**"] }, overlayAssets: assets })
    const config: Record<string, unknown> = { base: "/portal/", nitro: { plugins: [] }, root }
    await configHook(plugin)(config)
    const nitro = config.nitro as { handlers: Array<Record<string, unknown>>, plugins: string[], publicAssets: Array<Record<string, unknown>> }
    expect(nitro.publicAssets).toEqual([{ baseURL: "/portal/_vitehub/comments", dir: assets.dir, fallthrough: false, maxAge: 31_536_000 }])
    expect(nitro.handlers).toEqual([{ handler: join(root, ".vitehub/comments/inject-overlay.mjs"), middleware: true, route: "/**" }])
    expect(await readFile(nitro.handlers[0]!.handler as string, "utf8")).toContain("/portal/_vitehub/comments/loader.js?v=abc123&amp;o=")

    // Nitro 2, under Nuxt, renders through a hook, and the plugin adds the tag once.
    const generated = await readFile(nitro.plugins[0]!, "utf8")
    expect(generated).toContain("render:html")
    const hooks = new Map<string, (html: { bodyAppend: string[] }) => void>()
    const source = generated.replaceAll(/^import .*$/gm, "").replace("export default function", "function").replace(/const databaseName[\s\S]*?\nconst overlayTag/, "const overlayTag")
    const run = new Function("installComments", "databases", "createCommentsStore", "app", `${source}\nreturn viteHubComments`)
    const viteHubComments = run(() => undefined, {}, () => undefined, {}) as (app: unknown) => void
    viteHubComments({ hooks: { hook: (name: string, handler: (html: { bodyAppend: string[] }) => void) => hooks.set(name, handler) } })
    const html = { bodyAppend: [] as string[] }
    hooks.get("render:html")!(html)
    hooks.get("render:html")!(html)
    expect(html.bodyAppend).toHaveLength(1)
    expect(html.bodyAppend[0]).toContain("/portal/_vitehub/comments/loader.js")
    // Another host calls the plugin with no hooks at all.
    expect(() => viteHubComments(undefined)).not.toThrow()
  })
})
