// @vitest-environment node
import { describe, expect, it } from "vitest"

import { injectLoader, loaderTag, loaderUrl, mountPath, renderOverlayMiddleware, scriptNonce } from "../src/overlay.ts"

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
  async function middleware(loader = url) {
    const source = renderOverlayMiddleware(loader)
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
    for (const [path, method] of [["/", "POST"], ["/_vitehub/content", "GET"], ["/_vitehub", "GET"]] as const) {
      const response = html(page)
      expect(await (inject as (event: unknown, next: () => unknown) => Promise<Response>)(event(path, method), async () => response), `${method} ${path}`).toBe(response)
    }
    expect((await run(inject, html(page), event("/_vitehubs"))).text).toContain("loader.abc123.js")
    const object = { ok: true }
    expect(await (inject as (event: unknown, next: () => unknown) => Promise<unknown>)(event(), async () => object)).toBe(object)
  })

  it.each(["", "/portal"])("excludes only the mounted Console route at %s", async (mount) => {
    const loader = loaderUrl(mount, assets)
    const inject = await middleware(loader)
    for (const path of [`${mount}/_vitehub`, `${mount}/_vitehub/`, `${mount}/_vitehub/content`]) {
      const response = html(page)
      expect(await inject(event(path), async () => response), path).toBe(response)
      expect(await inject(event(path), async () => page), path).toBe(page)
    }
    for (const path of [`${mount}/docs/_vitehub/guide`, `${mount}/_vitehubs`, `${mount}/other/_vitehub`, mount ? "/_vitehub" : "/portal/_vitehub"]) {
      const expected = page.replace("</body>", `${loaderTag(loader)}</body>`)
      expect(await inject(event(path), async () => page), path).toBe(expected)
      expect((await run(inject, html(stream([page.slice(0, 12), page.slice(12)])), event(path))).text, path).toBe(expected)
    }
  })

  it("does nothing where the host calls it without next", async () => {
    expect(await (await middleware())({})).toBeUndefined()
  })
})

