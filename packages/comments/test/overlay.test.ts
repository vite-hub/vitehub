// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { defineComments, validateCommentsDefinition } from "../src/define.ts"
import { injectLoader, loaderTag, loaderUrl, mountPath, renderOverlayMiddleware, scriptNonce } from "../src/overlay.ts"
import { commentsNitroPluginPath, hubComments } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-comments-overlay-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), "{}")
  await mkdir(join(root, "server"))
  await writeFile(join(root, "server", "comments.ts"), `import { defineComments } from ${JSON.stringify(new URL("../src/define.ts", import.meta.url).href)}\nexport default defineComments()\n`)
  return root
}

type ConfigHook = (config: Record<string, unknown>, env?: { command: "serve" | "build" }) => Promise<void>
const configHook = (plugin: ReturnType<typeof hubComments>) => (plugin.config && "handler" in plugin.config ? plugin.config.handler : plugin.config) as unknown as ConfigHook
const indexHtml = (plugin: ReturnType<typeof hubComments>) => {
  const hook = plugin.transformIndexHtml
  return (hook && "handler" in hook ? hook.handler : hook) as unknown as (html: string) => string
}
const assets = { dir: "/dist/comments-overlay", loader: "loader.abc123.js", overlay: "overlay.def456.js" }
const inertMarkup = [
  '<svg><![CDATA[</body>]]></svg>',
  '<svg><![CDATA[> </body><script src="/_vitehub/comments/loader.old.js"></script>]]></svg>',
  '<math><![CDATA[> </html>]]></math>',
  `<svg><![CDATA[${"x".repeat(5_000)} </body>]]></svg>`,
  '<template><script src="/_vitehub/comments/loader.old.js"></script></template>',
  '<template><template><p>Nested</p></template><script src=/_vitehub/comments/loader.old.js></script></template>',
  '<script data-example=" src=\'/_vitehub/comments/loader.old.js\' "></script>',
]

describe("the overlay loader tag", () => {
  it("builds the URL below the app mount, with the overlay file and the page filter", () => {
    expect(mountPath(undefined)).toBe("")
    expect(mountPath("/")).toBe("")
    expect(mountPath("./")).toBe("")
    expect(mountPath("/portal/")).toBe("/portal")
    expect(mountPath("https://cdn.example.com/app/")).toBe("/app")
    expect(mountPath("//evil.example.com/")).toBe("")
    expect(loaderUrl("", assets)).toBe("/_vitehub/comments/loader.abc123.js?f=overlay.def456.js")
    expect(loaderUrl("", assets, { edit: true })).toBe("/_vitehub/comments/loader.abc123.js?f=overlay.def456.js&e=1")
    expect(loaderUrl("", assets, { session: "marker" })).toBe("/_vitehub/comments/loader.abc123.js?f=overlay.def456.js&s=marker")
    expect(loaderUrl("", assets, { session: "always" })).toBe("/_vitehub/comments/loader.abc123.js?f=overlay.def456.js&s=always")
    const filtered = loaderUrl("/portal", assets, { exclude: ["/admin/**"], paths: ["/docs/**"] })
    expect(filtered.startsWith("/portal/_vitehub/comments/loader.abc123.js?f=overlay.def456.js&o=")).toBe(true)
    expect(JSON.parse(decodeURIComponent(filtered.split("&o=")[1]!))).toEqual({ exclude: ["/admin/**"], paths: ["/docs/**"] })
    expect(loaderTag(filtered)).toBe(`<script type="module" src="${filtered.replaceAll("&", "&amp;")}"></script>`)
    expect(loaderTag("/x.js", "abc+/=-_")).toBe(`<script type="module" nonce="abc+/=-_" src="/x.js"></script>`)
    // A nonce that could break out of the attribute is dropped.
    expect(loaderTag("/x.js", `a" onload="x`)).toBe(`<script type="module" src="/x.js"></script>`)
  })

  it("goes before the first </body> or </html>, once, and never into a fragment", () => {
    const tag = loaderTag(loaderUrl("", assets))
    const html = "<html><body><main>Hi</main></body></html>"
    const once = injectLoader(html, tag)
    expect(once).toBe(`<html><body><main>Hi</main>${tag}</body></html>`)
    expect(injectLoader(once, tag)).toBe(once)
    expect(injectLoader("<html><main>Hi</main></html>", tag)).toBe(`<html><main>Hi</main>${tag}</html>`)
    expect(injectLoader("<p>fragment</p>", tag)).toBe("<p>fragment</p>")
    expect(injectLoader("{\"json\": true}", tag)).toBe("{\"json\": true}")
    // A mention of the file in text is not a loader tag.
    const mention = "<body><p>See /_vitehub/comments/loader.abc123.js</p></body>"
    expect(injectLoader(mention, tag)).toContain(tag)
    const comment = "<body><!-- /_vitehub/comments/loader.abc123.js --></body>"
    expect(injectLoader(comment, tag)).toContain(tag)
    expect(injectLoader(`<body><script src='/portal/_vitehub/comments/loader.zzz.js?f=overlay.q.js'></script></body>`, tag)).not.toContain(tag)
  })

  it("reads the nonce that the policy allows for scripts", () => {
    expect(scriptNonce("default-src 'self'; script-src 'self' 'nonce-abc123' 'strict-dynamic'")).toBe("abc123")
    expect(scriptNonce("script-src-elem 'nonce-elem'; script-src 'nonce-plain'")).toBe("elem")
    expect(scriptNonce("default-src 'nonce-fallback'")).toBe("fallback")
    expect(scriptNonce("script-src 'self'")).toBeUndefined()
    expect(scriptNonce("style-src 'nonce-style'")).toBeUndefined()
    expect(scriptNonce("script-src 'nonce-a\"b'")).toBeUndefined()
    expect(scriptNonce(null)).toBeUndefined()
  })

  it("ignores closing tags in raw text, comments and quoted attributes", () => {
    const tag = loaderTag(loaderUrl("", assets))
    for (const inner of [
      '<script>const closing = "</body>"</script>',
      '<style>p::after { content: "</html>" }</style>',
      '<!-- </body> -->',
      '<textarea></html></textarea>',
      '<div title="</body>">Hi</div>',
      '<!-- <script src="/_vitehub/comments/loader.old.js"></script> -->',
      ...inertMarkup,
    ]) {
      expect(injectLoader(`<body>${inner}</body>`, tag)).toBe(`<body>${inner}${tag}</body>`)
      expect(injectLoader(inner, tag)).toBe(inner)
    }
  })

  it("recognizes an existing loader with an unquoted src", () => {
    const source = '<body><script src=/_vitehub/comments/loader.old.js></script></body>'
    expect(injectLoader(source, loaderTag(loaderUrl("", assets)))).toBe(source)
  })
})

describe("the Nitro middleware", () => {
  const url = loaderUrl("", assets)
  async function middleware() {
    const source = renderOverlayMiddleware(url)
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    return (await import(/* @vite-ignore */ moduleUrl)).default as (event: unknown, next?: () => unknown) => Promise<unknown>
  }
  const event = (path = "/", method = "GET", type = "", extra: Record<string, string> = {}) => ({ req: { method, url: `http://localhost${path}` }, res: { headers: new Headers({ ...(type ? { "content-type": type } : {}), ...extra }) } })
  const page = "<html><body><h1>Hi</h1></body></html>"
  const html = (body: BodyInit, headers: Record<string, string> = {}, status = 200) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers }, status })
  const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close() } })
  const run = async (inject: Awaited<ReturnType<typeof middleware>>, response: Response, ev = event()) => {
    const result = await (inject as (event: unknown, next: () => unknown) => Promise<unknown>)(ev, async () => response) as Response
    return { headers: result.headers, status: result.status, text: await result.text() }
  }

  it("adds the loader to a streamed page, also when the closing tag is split across chunks", async () => {
    const inject = await middleware()
    const whole = await run(inject, html(page, { "content-length": String(page.length), etag: "\"x\"" }, 201))
    expect(whole.status).toBe(201)
    expect(whole.headers.has("content-length")).toBe(false)
    expect(whole.headers.has("etag")).toBe(false)
    expect(whole.text).toBe(page.replace("</body>", `<script type="module" src="${url.replaceAll("&", "&amp;")}"></script></body>`))
    for (const cut of [4, 5, 6, 7, 11, 20, page.indexOf("</body>") + 3, page.indexOf("</body>") + 6]) {
      const split = await run(inject, html(stream([page.slice(0, cut), page.slice(cut)])))
      expect(split.text, `cut at ${cut}`).toBe(whole.text)
    }
    // Many small chunks, and a long page: the tail that is held back never loses text.
    const long = `<html><body>${"<p>é paragraph</p>".repeat(2_000)}</body></html>`
    const many = await run(inject, html(stream(Array.from({ length: 200 }, (_, index) => long.slice(index * Math.ceil(long.length / 200), (index + 1) * Math.ceil(long.length / 200))))))
    expect(many.text).toBe(long.replace("</body>", `<script type="module" src="${url.replaceAll("&", "&amp;")}"></script></body>`))
  })

  it("leaves fragments, other types, other charsets, compressed bodies, and empty bodies alone", async () => {
    const inject = await middleware()
    expect((await run(inject, html("<p>Only a fragment</p>"))).text).toBe("<p>Only a fragment</p>")
    expect((await run(inject, html(stream(["<p>a fragment</p>", "<p>in chunks</p>"])))).text).toBe("<p>a fragment</p><p>in chunks</p>")
    const untouched = [
      new Response(page, { headers: { "content-type": "application/json" } }),
      new Response(page, { headers: { "content-type": "text/plain" } }),
      new Response(page, { headers: { "content-type": "application/xhtml+xml" } }),
      html(page, { "content-type": "text/html; charset=iso-8859-1" }),
      html(page, { "content-encoding": "gzip" }),
      html(page, { "content-encoding": "br" }),
      new Response(null, { headers: { "content-type": "text/html" }, status: 304 }),
      new Response(null, { headers: { "content-type": "text/html" }, status: 204 }),
    ]
    for (const response of untouched) {
      const result = await (inject as (event: unknown, next: () => unknown) => Promise<Response>)(event(), async () => response)
      expect(result).toBe(response)
    }
    const identity = await run(inject, html(page, { "content-encoding": "identity" }))
    expect(identity.text).toContain("loader.abc123.js")
    expect((await run(inject, html(page, { "content-type": "text/html" }))).text).toContain("loader.abc123.js")
    expect((await run(inject, html(page, { "content-type": "TEXT/HTML; Charset=UTF-8" }))).text).toContain("loader.abc123.js")
  })

  it("preserves partial responses and their validators", async () => {
    const inject = await middleware()
    for (const status of [200, 206]) {
      const headers = { "content-length": String(page.length), "content-range": `bytes 0-${page.length - 1}/1000`, etag: '"partial"' }
      const response = html(page, headers, status)
      expect(await inject(event(), async () => response)).toBe(response)
      expect(response.status).toBe(status)
      for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value)
      expect(await response.text()).toBe(page)
    }
    const response = html(page, {}, 206)
    expect(await inject(event(), async () => response)).toBe(response)
    expect(await inject(event("/", "GET", "text/html", { "content-range": "bytes 0-10/100" }), async () => page)).toBe(page)
  })

  it("keeps HTML contexts across stream chunks and the held-back tail", async () => {
    const inject = await middleware()
    const inner = `<script>${"x".repeat(5_000)}; const closing = "</body>"</script><!-- </html> --><style>p::after { content: "</body>" }</style>`
    const source = `<body>${inner}</body>`
    const expected = `<body>${inner}${loaderTag(url)}</body>`
    const chunks = Array.from(source, char => char)
    expect((await run(inject, html(stream(chunks)))).text).toBe(expected)
    expect(await inject(event(), async () => source)).toBe(expected)
  })

  it("preserves CDATA and templates and recognizes unquoted loaders in strings and streams", async () => {
    const inject = await middleware()
    for (const inner of inertMarkup) {
      const source = `<body>${inner}</body>`
      const expected = `<body>${inner}${loaderTag(url)}</body>`
      expect(await inject(event(), async () => source)).toBe(expected)
      expect((await run(inject, html(stream([...source])))).text).toBe(expected)
    }
    const source = '<body><script src=/_vitehub/comments/loader.old.js></script></body>'
    expect(await inject(event(), async () => source)).toBe(source)
    expect((await run(inject, html(stream([...source])))).text).toBe(source)
  })

  it("drops string response validators only when the body changes", async () => {
    const inject = await middleware()
    for (const source of [page, '<p>fragment</p>', `<body>${loaderTag(url)}</body>`]) {
      const ev = event("/", "GET", "text/html", { "content-length": String(source.length), etag: '"old"' })
      const result = await inject(ev, async () => source)
      const changed = source === page
      expect(result !== source).toBe(changed)
      expect(ev.res.headers.get("content-length")).toBe(changed ? null : String(source.length))
      expect(ev.res.headers.get("etag")).toBe(changed ? null : '"old"')
    }
  })

  it("preserves Unicode at the retained tail and after injection", async () => {
    const inject = await middleware()
    const first = `<body>😀${"x".repeat(4095)}`
    const source = `${first}</body>😀`
    expect((await run(inject, html(stream([first, "</body>😀"])))).text).toBe(`${first}${loaderTag(url)}</body>😀`)
    const bytes = new TextEncoder().encode(source)
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, -2))
      controller.enqueue(bytes.slice(-2))
      controller.close()
    } })
    expect((await run(inject, html(body))).text).toBe(`${first}${loaderTag(url)}</body>😀`)
  })

  it("rewrites strings only when they are HTML", async () => {
    const inject = await middleware()
    const string = (text: string, type = "", extra: Record<string, string> = {}) => (inject as (event: unknown, next: () => unknown) => Promise<unknown>)(event("/", "GET", type, extra), async () => text)
    expect(await string(page, "text/html")).toContain("loader.abc123.js")
    expect(await string(page)).toContain("loader.abc123.js")
    expect(await string("<p>fragment</p>", "text/html")).toBe("<p>fragment</p>")
    expect(await string("<p>fragment</p>")).toBe("<p>fragment</p>")
    // A type that is not HTML means a string with markup in it is data.
    expect(await string(page, "application/json")).toBe(page)
    expect(await string(page, "text/plain")).toBe(page)
    expect(await string(page, "text/html; charset=latin1")).toBe(page)
    expect(await string(page, "text/html", { "content-encoding": "gzip" })).toBe(page)
  })

  it("adds the script nonce of the response policy to the tag", async () => {
    const inject = await middleware()
    const response = await run(inject, html(page, { "content-security-policy": "script-src 'nonce-Zm9vYg==' 'strict-dynamic'" }))
    expect(response.text).toContain(`<script type="module" nonce="Zm9vYg==" src=`)
    const string = await (inject as (event: unknown, next: () => unknown) => Promise<string>)(event("/", "GET", "text/html", { "content-security-policy": "default-src 'nonce-n0nce'" }), async () => page)
    expect(string).toContain(`nonce="n0nce"`)
    expect((await run(inject, html(page, { "content-security-policy": "script-src 'self'" }))).text).not.toContain("nonce")
  })

  it("applies a response nonce to a loader already injected by Vite", async () => {
    const inject = await middleware()
    const policy = { "content-security-policy": "script-src 'nonce-current' 'strict-dynamic'" }
    for (const nonce of [undefined, "build-time"]) {
      const source = `<body>${loaderTag(url, nonce)}</body>`
      const expected = `<body>${loaderTag(url, "current")}</body>`
      expect(await inject(event("/", "GET", "text/html", policy), async () => source)).toBe(expected)
      expect((await run(inject, html(stream([...source]), policy))).text).toBe(expected)
    }
  })

  it("does not add a second loader, and skips other methods, the Console, and anything that is not a page", async () => {
    const inject = await middleware()
    const tagged = `<html><body><script type="module" src="/_vitehub/comments/loader.old.js?f=overlay.old.js"></script></body></html>`
    expect((await run(inject, html(stream([tagged.slice(0, 40), tagged.slice(40)])))).text).toBe(tagged)
    expect((await run(inject, html(tagged))).text).toBe(tagged)
    for (const [path, method] of [["/", "POST"], ["/_vitehub/content", "GET"], ["/_vitehub", "GET"], ["/portal/_vitehub", "GET"]] as const) {
      const response = html(page)
      expect(await (inject as (event: unknown, next: () => unknown) => Promise<Response>)(event(path, method), async () => response), `${method} ${path}`).toBe(response)
    }
    expect((await run(inject, html(page), event("/_vitehubs"))).text).toContain("loader.abc123.js")
    const object = { ok: true }
    expect(await (inject as (event: unknown, next: () => unknown) => Promise<unknown>)(event(), async () => object)).toBe(object)
  })

  it("does nothing where the host calls it without next", async () => {
    expect(await (await middleware())({})).toBeUndefined()
  })
})

describe("hubComments overlay", () => {
  it.each(["serve", "build"] as const)("matches the host RPC availability in %s mode", async (command) => {
    const root = await project()
    const plugin = hubComments({ overlayAssets: assets, overlayDevOnly: true })
    const config = { root }
    await configHook(plugin)(config, { command })
    expect(indexHtml(plugin)("<body>Hi</body>").includes("comments/loader.")).toBe(command === "serve")
    const nitro = Reflect.get(config, "nitro")
    expect(nitro.handlers?.length ?? 0).toBe(command === "serve" ? 1 : 0)
    expect(nitro.publicAssets?.length ?? 0).toBe(command === "serve" ? 1 : 0)
    const runtime = await readFile(join(root, commentsNitroPluginPath), "utf8")
    expect(runtime.includes("overlayUrl")).toBe(command === "serve")
  })

  it("injects the loader into index.html, and into nothing without the assets, the file, or when it is off", async () => {
    const root = await project()
    const plugin = hubComments({ overlayAssets: assets })
    await configHook(plugin)({ root })
    await (plugin.configResolved as unknown as (config: { base: string, plugins: unknown[] }) => Promise<void>)({ base: "/", plugins: [{ name: "@vite-hub/database/vite" }] })
    expect(indexHtml(plugin)("<body>Hi</body>")).toBe(`<body>Hi<script type="module" src="/_vitehub/comments/loader.abc123.js?f=overlay.def456.js"></script></body>`)

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

  it("follows the resolved base: the generated files are written again when it differs from the config", async () => {
    const root = await project()
    const plugin = hubComments({ overlayAssets: assets })
    await configHook(plugin)({ root })
    const middleware = join(root, ".vitehub/comments/inject-overlay.mjs")
    expect(await readFile(middleware, "utf8")).toContain('"/_vitehub/comments/loader.abc123.js')
    const resolved = plugin.configResolved as unknown as (config: { base: string, plugins: unknown[] }) => Promise<void>
    await resolved({ base: "/docs/", plugins: [{ name: "@vite-hub/database/vite" }] })
    expect(await readFile(middleware, "utf8")).toContain('"/docs/_vitehub/comments/loader.abc123.js')
    expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).toContain('"/docs/_vitehub/comments/loader.abc123.js')
    expect(indexHtml(plugin)("<body></body>")).toContain('src="/docs/_vitehub/comments/loader.abc123.js')
  })

  it("serves the loader below the app base under Nuxt, whose Vite base is the assets folder in dev", async () => {
    const nuxtDev = (base: string) => ({ base: "/_nuxt/", define: { __VITEHUB_APP_BASE_URL__: JSON.stringify(base) }, __vitehubNitroConfigContext: true })
    for (const [base, mount] of [["/", ""], ["/portal/", "/portal"]] as const) {
      const root = await project()
      const plugin = hubComments({ overlayAssets: assets })
      const config: Record<string, unknown> = { nitro: { plugins: [] }, root, ...nuxtDev(base) }
      await configHook(plugin)(config)
      const generated = `"${mount}/_vitehub/comments/loader.abc123.js`
      expect(await readFile(join(root, ".vitehub/comments/inject-overlay.mjs"), "utf8")).toContain(generated)
      expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).toContain(generated)
      expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).not.toContain("/_nuxt/")
      // The resolved config carries Vite's base, and by then another plugin has replaced the define with it. The loader stays.
      await (plugin.configResolved as unknown as (config: Record<string, unknown>) => Promise<void>)({ ...nuxtDev(base), define: { __VITEHUB_APP_BASE_URL__: JSON.stringify("/_nuxt/") }, nitro: config.nitro, plugins: [{ name: "@vite-hub/database/vite" }] })
      expect(await readFile(join(root, ".vitehub/comments/inject-overlay.mjs"), "utf8")).toContain(generated)
      expect(indexHtml(plugin)("<body></body>")).toContain(`src="${mount}/_vitehub/comments/loader.abc123.js`)
      expect(JSON.stringify((config.nitro as { publicAssets?: unknown }).publicAssets)).toContain(`"baseURL":"${mount}/_vitehub/comments"`)
    }
  })

  it("tells the loader that the app can edit pages only when the check says so", async () => {
    const root = await project()
    const withEdit = hubComments({ overlayAssets: assets, overlayEdit: project => project.projectRoot === root })
    await configHook(withEdit)({ root })
    expect(indexHtml(withEdit)("<body></body>")).toContain("overlay.def456.js&amp;e=1")
    const without = hubComments({ overlayAssets: assets })
    await configHook(without)({ root })
    expect(indexHtml(without)("<body></body>")).not.toContain("e=1")
    const no = hubComments({ overlayAssets: assets, overlayEdit: () => false })
    await configHook(no)({ root })
    expect(indexHtml(no)("<body></body>")).not.toContain("e=1")
  })

  it("moves the served path of the bundle with the resolved base", async () => {
    const root = await project()
    const plugin = hubComments({ overlayAssets: assets })
    const config: Record<string, unknown> = { nitro: { plugins: [] }, root }
    await configHook(plugin)(config)
    const nitro = config.nitro as { publicAssets: Array<{ baseURL: string }> }
    expect(nitro.publicAssets[0]!.baseURL).toBe("/_vitehub/comments")
    await (plugin.configResolved as unknown as (config: unknown) => Promise<void>)({ base: "/docs/", nitro: config.nitro, plugins: [{ name: "@vite-hub/database/vite" }] })
    expect(nitro.publicAssets[0]!.baseURL).toBe("/docs/_vitehub/comments")
  })

  it("serves the bundle from Nitro with a long cache and adds the middleware and the render hook", async () => {
    const root = await project()
    const plugin = hubComments({ overlay: { exclude: ["/admin/**"] }, overlayAssets: assets })
    const config: Record<string, unknown> = { base: "/portal/", nitro: { plugins: [] }, root }
    await configHook(plugin)(config)
    const nitro = config.nitro as { handlers: Array<Record<string, unknown>>, plugins: string[], publicAssets: Array<Record<string, unknown>> }
    expect(nitro.publicAssets).toEqual([{ baseURL: "/portal/_vitehub/comments", dir: assets.dir, fallthrough: false, maxAge: 31_536_000 }])
    expect(nitro.handlers).toEqual([{ handler: join(root, ".vitehub/comments/inject-overlay.mjs"), middleware: true, route: "/**" }])
    expect(await readFile(nitro.handlers[0]!.handler as string, "utf8")).toContain("/portal/_vitehub/comments/loader.abc123.js?f=overlay.def456.js&o=")

    // Nitro 2, under Nuxt, renders through a hook, and the plugin adds the tag once.
    const generated = await readFile(nitro.plugins[0]!, "utf8")
    expect(generated).toContain("render:html")
    const hooks = new Map<string, (html: { bodyAppend: string[] }, context?: unknown) => void>()
    const source = generated.replaceAll(/^import .*$/gm, "").replace("export default function", "function").replace(/const databaseName[\s\S]*?\nconst overlayUrl/, "const overlayUrl")
    const run = new Function("installComments", "databases", "createCommentsStore", "app", "validateCommentsDefinition", `${source}\nreturn viteHubComments`)
    const viteHubComments = run(() => undefined, {}, () => undefined, { default: defineComments() }, validateCommentsDefinition) as (app: unknown) => void
    viteHubComments({ hooks: { hook: (name: string, handler: (html: { bodyAppend: string[] }, context?: unknown) => void) => hooks.set(name, handler) } })
    const html = { bodyAppend: [] as string[] }
    hooks.get("render:html")!(html)
    hooks.get("render:html")!(html)
    expect(html.bodyAppend).toHaveLength(1)
    expect(html.bodyAppend[0]).toContain("/portal/_vitehub/comments/loader.abc123.js")
    expect(html.bodyAppend[0]).not.toContain("nonce")
    // Under a Content-Security-Policy with a script nonce, the tag carries it.
    const strict = { bodyAppend: [] as string[] }
    hooks.get("render:html")!(strict, { event: { node: { res: { getHeader: (name: string) => name === "content-security-policy" ? "script-src 'nonce-Zm9v' 'strict-dynamic'" : undefined } } } })
    expect(strict.bodyAppend[0]).toContain(`nonce="Zm9v"`)
    // A page that has the loader already (a second hook run, or an app that added it) gets no second one.
    const tagged = { bodyAppend: [`<script type="module" src="/_vitehub/comments/loader.old.js?f=overlay.old.js"></script>`] }
    hooks.get("render:html")!(tagged)
    expect(tagged.bodyAppend).toHaveLength(1)
    // Another host calls the plugin with no hooks at all.
    expect(() => viteHubComments(undefined)).not.toThrow()
  })
})
