import { spawn } from "node:child_process"
import { request as httpRequest } from "node:http"
import { mkdir, readdir, readFile, symlink } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"

import { createClient } from "@libsql/client"

const repositoryRoot = resolve(import.meta.dirname, "../../..")
const historyMigration = join(repositoryRoot, "packages/workspace/test/fixtures/history.sql")

/** 32 bytes as base64: a production signing key, so preview does not rely on the development fallback. */
export const contentKey = Buffer.alloc(32, 5).toString("base64")

/**
 * `server/content.ts` for a built app: a real Content runtime over a Blob + Database Workspace with retained history.
 * Blob objects live in memory; the SQLite file comes from CONTENT_FIXTURE_DATABASE.
 */
export const contentModule = `
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import * as v from "valibot"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"
import { defineContent, documents } from "vite-hub/content"

const objects = new Map()
const object = (pathname, bytes) => ({ pathname, size: bytes.byteLength, contentType: "application/octet-stream", uploadedAt: new Date() })
const blob = {
  async get(pathname) { const bytes = objects.get(pathname); return [undefined, bytes ? new Blob([bytes]) : null] },
  async head(pathname) { const bytes = objects.get(pathname); return [undefined, bytes ? object(pathname, bytes) : null] },
  async put(pathname, body) { const bytes = new Uint8Array(await new Response(body).arrayBuffer()); objects.set(pathname, bytes); return [undefined, object(pathname, bytes)] },
  async del(pathnames) { for (const pathname of [pathnames].flat()) objects.delete(pathname); return [undefined, undefined] },
  async list({ prefix = "" } = {}) { return [undefined, { blobs: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => object(key, bytes)), hasMore: false }] },
}
const database = drizzle(createClient({ url: "file:" + process.env.CONTENT_FIXTURE_DATABASE }), { schema: workspaceHistorySchema })
registerWorkspace("site", { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: "site" }) })

export const content = defineContent({
  workspace: "site",
  collections: { posts: documents({ path: "posts/**/*.md", fields: { title: v.string() } }) },
  logger: false,
})
`

/**
 * Server routes, as `[path, source]`, relative to the server directory. `handler` wraps each handler expression:
 * Nitro 3 takes a plain function, and Nuxt's Nitro 2 takes `defineEventHandler()`.
 */
export function contentRoutes(contentImport: string, handler = (code: string) => code): Array<[string, string]> {
  const page = (delay: number) => `
import { content } from ${JSON.stringify(contentImport)}

let renders = 0
export default ${handler(`async () => {
  ${delay ? `await new Promise(resolve => setTimeout(resolve, ${delay}))` : ""}
  const post = await content.collection("posts").get("hello")
  return { title: post?.data.title, render: ++renders }
}`)}
`
  return [
    ["routes/page.ts", page(0)],
    ["routes/slow.ts", page(300)],
    ["routes/seed.post.ts", `
import { content } from ${JSON.stringify(contentImport)}

export default ${handler(`async () => {
  const posts = content.collection("posts")
  await posts.save("hello", { data: { title: "Published" }, body: "# Hello" })
  await posts.save("other", { data: { title: "Other published" }, body: "# Other" })
  await content.publish()
  await posts.save("hello", { data: { title: "Draft" }, body: "# Hello" })
  await posts.save("other", { data: { title: "Other draft" }, body: "# Other draft" })
  return { ok: true }
}`)}
`],
    ["routes/preview.post.ts", `
import { content } from ${JSON.stringify(contentImport)}

export default ${handler(`async event => await content.preview.enable(event)`)}
`],
  ]
}

/** Route rules that cache the content pages for a minute, served stale while revalidating. */
export const cachedRouteRules = { "/page": { swr: 60 }, "/slow": { swr: 60 } }

/** Link the packages a fixture app needs: the repository's root packages, the libSQL client, and `extra` packages. */
export async function linkFixtureModules(root: string, extra: Record<string, string> = {}): Promise<void> {
  const modules = join(root, "node_modules")
  await mkdir(modules, { recursive: true })
  const rootModules = join(repositoryRoot, "node_modules")
  for (const entry of await readdir(rootModules)) {
    if (entry === ".bin" || entry === ".pnpm" || entry.startsWith(".")) continue
    await symlink(join(rootModules, entry), join(modules, entry), "dir")
  }
  await mkdir(join(modules, "@libsql"))
  await symlink(join(repositoryRoot, "packages/vite-hub/node_modules/@libsql/client"), join(modules, "@libsql/client"), "dir")
  for (const [name, path] of Object.entries(extra)) await symlink(path, join(modules, name), "dir")
}

/** Create the Workspace history tables in a fresh SQLite file. */
export async function createHistoryDatabase(path: string): Promise<void> {
  const client = createClient({ url: `file:${path}` })
  try {
    await client.executeMultiple(await readFile(historyMigration, "utf8"))
  }
  finally {
    client.close()
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

export interface BuiltServer {
  close(): void
  pid: number | undefined
  port: number
  fetch(path: string, init?: RequestInit): Promise<Response>
}

/** Start `.output/server/index.mjs` and wait until it answers. */
export async function startBuiltServer(root: string, env: Record<string, string>): Promise<BuiltServer> {
  const port = await freePort()
  let output = ""
  const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
    env: { ...process.env, ...env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  server.stderr.on("data", (chunk: Buffer) => { output += chunk.toString() })
  const fetchServer = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init)
  const deadline = Date.now() + 20_000
  while (true) {
    try {
      await fetchServer("/__vitehub_fixture_ready")
      break
    }
    catch (error) {
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`Built server did not start:\n${output}`, { cause: error })
      await new Promise(done => setTimeout(done, 100))
    }
  }
  return { close: () => server.kill(), fetch: fetchServer, pid: server.pid, port }
}

interface PageRead {
  body: unknown
  cacheControl: string | null
  robots: string | null
}

/**
 * Seed a published and a draft title, then show that preview requests to `cache`/`swr` routes never populate the
 * cache, never receive the cached public response, and never share an in-flight render with a public request.
 */
export async function expectPreviewBypassesCache(server: BuiltServer, expect: typeof import("vitest").expect): Promise<void> {
  expect((await server.fetch("/seed", { method: "POST" })).status).toBe(200)
  const enabled = await server.fetch("/preview", { method: "POST" })
  expect(enabled.status).toBe(200)
  const cookie = enabled.headers.get("set-cookie")?.split(";", 1)[0]
  expect(cookie).toMatch(/^vitehub-content-preview=v1\./)
  const read = async (path: string, preview: boolean): Promise<PageRead> => {
    const response = await server.fetch(path, preview ? { headers: { cookie: `theme=dark; ${cookie}` } } : undefined)
    expect(response.status).toBe(200)
    return { body: await response.json(), cacheControl: response.headers.get("cache-control"), robots: response.headers.get("x-robots-tag") }
  }
  const privately = { cacheControl: "private, no-store", robots: "noindex, nofollow" }

  // (a) A preview render on a cold cache is not stored: the next public request renders the published title.
  expect(await read("/page", true)).toEqual({ body: { title: "Draft", render: 1 }, ...privately })
  const publicMiss = await read("/page", false)
  expect(publicMiss.body).toEqual({ title: "Published", render: 2 })
  expect(publicMiss.robots).toBeNull()
  expect((await read("/page", false)).body).toEqual({ title: "Published", render: 2 })

  // (b) A preview request renders the draft instead of receiving the cached public page, and leaves that entry alone.
  expect(await read("/page", true)).toEqual({ body: { title: "Draft", render: 3 }, ...privately })
  expect((await read("/page", false)).body).toEqual({ title: "Published", render: 2 })

  // A public request that arrives during a preview render of the same cold key does not join that render.
  const [preview, publicRead] = await Promise.all([
    read("/slow", true),
    new Promise<PageRead>(done => setTimeout(() => done(read("/slow", false)), 50)),
  ])
  expect(preview).toMatchObject({ body: { title: "Draft" }, ...privately })
  expect(publicRead.body).toMatchObject({ title: "Published" })
  expect((await read("/slow", false)).body).toEqual(publicRead.body)
}

/**
 * `server/frame-page.ts`, next to `server/content.ts`: the HTML page that frame redirects land on, and the headers each
 * redirect hop answers with, so a browser run sees what every hop read and which cookies it got.
 */
const framePage = `
import { content } from "./content.ts"

const escape = value => String(value ?? "").replace(/[&<>"]/g, character => "&#" + character.charCodeAt(0) + ";")

export const page = async (cookie, method = "GET", type = null) => {
  const posts = content.collection("posts")
  const post = await posts.get("hello")
  const other = await posts.get("other")
  const session = /(?:^|; )session=([^;]*)/.exec(cookie ?? "")?.[1] ?? ""
  return \`<!doctype html><html><head><title>Frame</title></head><body><h1>\${escape(post?.data.title)}</h1><pre id="body">\${escape(post?.body)}</pre><p id="other">\${escape(other?.data.title)}</p><p id="session">\${escape(session)}</p><p id="frame">\${escape(content.preview.frame()?.id)}</p><p id="cookie">\${escape(cookie)}</p><p id="method">\${escape(method)}</p><p id="type">\${escape(type)}</p></body></html>\`
}

export const hopHeaders = async cookie => ({ "x-frame-title": String((await content.collection("posts").get("hello"))?.data.title), "x-seen-cookie": cookie ?? "" })
`

/** A redirect hop of the cookie checks: its status, its `Location` as a JavaScript expression of `url`, and its cookies. */
interface FrameHop {
  path: string
  status: number
  location: string
  cookies?: string[]
}

/** Routes that only set cookies, for a browser to visit before a frame posts. */
const cookieSetters: Array<[string, string[]]> = [
  ["admin/set", ["admin=secret; Path=/admin; HttpOnly"]],
  ["set-root", ["pref=root; Path=/", "gone=1; Path=/"]],
  ["deep/set", ["pref=deep; Path=/deep"]],
]

/**
 * The redirect chains of the browser cookie checks. `url` is the request URL, so `new URL(..., url)` makes an absolute
 * `Location` on the same origin, and `localhost` makes one on another origin of the same server.
 */
const frameHops: FrameHop[] = [
  // An HttpOnly cookie for /admin: the browser sends it to /admin/frame and never to /echo.
  { path: "admin/frame", status: 302, location: `"/echo"` },
  // A sign-in, a locale, and an absolute canonical redirect. The session has Path=/; the scoped cookie Path=/admin.
  { path: "sign-in", status: 302, location: `"/locale"`, cookies: ["session=s1; Path=/; HttpOnly; SameSite=Lax", "scoped=1; Path=/admin"] },
  { path: "locale", status: 301, location: `"en/canonical?x=a%20b&flag"` },
  { path: "en/canonical", status: 308, location: `new URL("/echo?lang=en#intro", url).href` },
  // Two cookies of the same name on different paths.
  { path: "deep/start", status: 303, location: `"/deep/echo"` },
  { path: "deep/out", status: 302, location: `"../echo"` },
  // Prefix rules and expiry stay with the browser: it refuses __Host-bad, keeps __Host-ok, and deletes gone.
  { path: "prefixes", status: 302, location: `"/echo"`, cookies: ["__Host-bad=1; Secure", "__Host-ok=1; Secure; Path=/", "__Secure-bad=1", "gone=; Path=/; Max-Age=0"] },
  { path: "away-local", status: 302, location: `"http://localhost:" + url.port + "/echo"` },
  { path: "invalid", status: 302, location: `"http://["` },
]

/** The page and redirect routes of the browser cookie checks, on Nitro 3 or Nitro 2. */
function cookieRoutes(host: "nitro3" | "nitro2"): Array<[string, string]> {
  const from = (path: string) => "../".repeat(path.split("/").length)
  const page = (path: string) => host === "nitro3"
    ? `import { page } from "${from(path)}frame-page.ts"\n\nexport default async event => new Response(await page(event.req.headers.get("cookie"), event.req.method, event.req.headers.get("content-type")), { headers: { "content-type": "text/html; charset=utf-8" } })\n`
    : `import { page } from "${from(path)}frame-page.ts"\n\nexport default defineEventHandler(async (event) => {\n  setResponseHeader(event, "content-type", "text/html; charset=utf-8")\n  return await page(getHeader(event, "cookie"), event.method, getHeader(event, "content-type") ?? null)\n})\n`
  const setter = (cookies: string[]) => host === "nitro3"
    ? `export default () => {\n  const headers = new Headers()\n  for (const cookie of ${JSON.stringify(cookies)}) headers.append("set-cookie", cookie)\n  return new Response("ok", { headers })\n}\n`
    : `export default defineEventHandler((event) => {\n  for (const cookie of ${JSON.stringify(cookies)}) appendResponseHeader(event, "set-cookie", cookie)\n  return "ok"\n})\n`
  const hop = ({ path, status, location, cookies = [] }: FrameHop) => host === "nitro3"
    ? `import { hopHeaders } from "${from(path)}frame-page.ts"\n\nexport default async (event) => {\n  const url = new URL(event.req.url)\n  const headers = new Headers(await hopHeaders(event.req.headers.get("cookie")))\n  headers.set("location", ${location})\n  for (const cookie of ${JSON.stringify(cookies)}) headers.append("set-cookie", cookie)\n  return new Response(null, { status: ${status}, headers })\n}\n`
    // h3 v1 sendRedirect() writes the head and an HTML body on the Node response.
    : `import { hopHeaders } from "${from(path)}frame-page.ts"\n\nexport default defineEventHandler(async (event) => {\n  const url = getRequestURL(event)\n  for (const [name, value] of Object.entries(await hopHeaders(getHeader(event, "cookie")))) setResponseHeader(event, name, value)\n  for (const cookie of ${JSON.stringify(cookies)}) appendResponseHeader(event, "set-cookie", cookie)\n  return sendRedirect(event, ${location}, ${status})\n})\n`
  return [
    ...["echo", "deep/echo", "admin/echo"].map((path): [string, string] => [`routes/${path}.ts`, page(path)]),
    ...cookieSetters.map(([path, cookies]): [string, string] => [`routes/${path}.ts`, setter(cookies)]),
    ...frameHops.map((entry): [string, string] => [`routes/${entry.path}.ts`, hop(entry)]),
  ]
}

/**
 * Routes of preview frame redirects on Nitro 3, as Web responses: a redirect to an HTML page, a sign-in redirect that
 * sets two cookies for a page that needs one, a redirect to another site, a loop, and the browser cookie checks.
 * `/sign` signs posts/hello.
 */
export function nitro3FrameRoutes(contentImport: string): Array<[string, string]> {
  const html = (code: string) => `new Response(${code}, { headers: { "content-type": "text/html; charset=utf-8" } })`
  const redirect = (location: string) => `export default () => new Response(null, { status: 302, headers: { location: ${JSON.stringify(location)} } })\n`
  return [
    ["frame-page.ts", framePage],
    ["routes/sign.post.ts", `import { content } from ${JSON.stringify(contentImport)}\n\nexport default async () => await content.preview.sign({ collection: "posts", id: "hello" })\n`],
    ["routes/frame-page.ts", `import { page } from "../frame-page.ts"\n\nexport default async event => ${html(`await page(event.req.headers.get("cookie"))`)}\n`],
    ["routes/account.ts", `import { page } from "../frame-page.ts"\n\nexport default async (event) => {\n  const cookie = event.req.headers.get("cookie") ?? ""\n  if (!cookie.includes("session=")) return new Response("Sign in first", { status: 401 })\n  return ${html("await page(cookie)")}\n}\n`],
    ["routes/go.ts", redirect("/frame-page?from=go#intro")],
    ["routes/web-page.ts", `import { page } from "../frame-page.ts"\n\nexport default async event => ${html(`await page(event.req.headers.get("cookie"))`)}\n`],
    ["routes/go-web.ts", redirect("/web-page")],
    ["routes/login.ts", `export default () => {\n  const headers = new Headers({ location: "/account" })\n  headers.append("set-cookie", "session=abc123; Path=/; HttpOnly; SameSite=Lax")\n  headers.append("set-cookie", "theme=dark; Path=/; Max-Age=3600")\n  return new Response(null, { status: 302, headers })\n}\n`],
    ["routes/away.ts", redirect("https://example.invalid/blog/hello")],
    ["routes/loop.ts", redirect("/loop")],
    ...cookieRoutes("nitro3"),
  ]
}

/** The same routes on Nitro 2, with the h3 v1 helpers that write the Node response directly. */
export function nitro2FrameRoutes(contentImport: string): Array<[string, string]> {
  const redirect = (location: string) => `export default defineEventHandler(event => sendRedirect(event, ${JSON.stringify(location)}, 302))\n`
  const html = `setResponseHeader(event, "content-type", "text/html; charset=utf-8")`
  return [
    ["frame-page.ts", framePage],
    ["routes/sign.post.ts", `import { content } from ${JSON.stringify(contentImport)}\n\nexport default defineEventHandler(async () => await content.preview.sign({ collection: "posts", id: "hello" }))\n`],
    ["routes/frame-page.ts", `import { page } from "../frame-page.ts"\n\nexport default defineEventHandler(async (event) => {\n  ${html}\n  return await page(getHeader(event, "cookie"))\n})\n`],
    ["routes/account.ts", `import { page } from "../frame-page.ts"\n\nexport default defineEventHandler(async (event) => {\n  if (!getCookie(event, "session")) throw createError({ statusCode: 401, statusMessage: "Sign in first" })\n  ${html}\n  return await page(getHeader(event, "cookie"))\n})\n`],
    ["routes/go.ts", redirect("/frame-page?from=go#intro")],
    // A handler that returns a Web Response: h3 v1 sends its body as a stream.
    ["routes/web-page.ts", `import { page } from "../frame-page.ts"\n\nexport default defineEventHandler(async event => new Response(await page(getHeader(event, "cookie")), { headers: { "content-type": "text/html; charset=utf-8" } }))\n`],
    ["routes/go-web.ts", redirect("/web-page")],
    ["routes/login.ts", `export default defineEventHandler((event) => {\n  setCookie(event, "session", "abc123", { path: "/", httpOnly: true, sameSite: "lax" })\n  setCookie(event, "theme", "dark", { path: "/", maxAge: 3600 })\n  return sendRedirect(event, "/account", 302)\n})\n`],
    ["routes/away.ts", redirect("https://example.invalid/blog/hello")],
    ["routes/loop.ts", redirect("/loop")],
    ...cookieRoutes("nitro2"),
  ]
}

/** The form of a preview frame with "On screen" as the title of posts/hello and an unsaved body. */
export function frameForm(token: string): string {
  return new URLSearchParams({ "vitehub-content-preview": JSON.stringify({ token, document: { collection: "posts", id: "hello", data: { title: "On screen" }, body: "# On screen\n\nUnsaved body." } }) }).toString()
}

/** Posts a preview frame form to `path` the way the Console frame does, without following redirects. */
export async function postFrame(server: BuiltServer, path: string, token: string, headers: Record<string, string> = {}): Promise<Response> {
  const url = new URL(path, `http://127.0.0.1:${server.port}`)
  if (!url.searchParams.has("vitehub-content-preview")) url.searchParams.set("vitehub-content-preview", "")
  return await server.fetch(`${url.pathname}${url.search}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${server.port}`, ...headers },
    body: frameForm(token),
  })
}

/**
 * Posts a frame form and posts it again to each `307` `Location`, as a browser does, with `cookie` on every request.
 * Returns the `Location` of each hop and the last response.
 */
export async function followFrame(server: BuiltServer, path: string, token: string, cookie?: string): Promise<{ locations: string[], response: Response }> {
  const locations: string[] = []
  let response = await postFrame(server, path, token, cookie ? { cookie } : {})
  while (response.status === 307) {
    const location = response.headers.get("location")!
    locations.push(location)
    response = await postFrame(server, location.split("#", 1)[0]!, token, cookie ? { cookie } : {})
  }
  return { locations, response }
}

/**
 * After `expectPreviewBypassesCache()` seeded posts/hello: a preview frame redirect to the same origin is a private
 * `307` with the next hop, so the browser posts the form again and the last page renders the posted document. The
 * redirect keeps its own cookies for the browser, and the server copies no cookie between hops. A redirect to another
 * site or a loop gets an error page. The same requests outside a frame keep their redirects.
 */
export async function expectFrameRedirects(server: BuiltServer, expect: typeof import("vitest").expect): Promise<string> {
  const signed: unknown = await (await server.fetch("/sign", { method: "POST" })).json()
  const token = String(Reflect.get(Object(signed), "token"))
  const titleOf = (html: string) => /<h1>([^<]*)<\/h1>/.exec(html)?.[1]
  const origin = `http://127.0.0.1:${server.port}`

  const go = await postFrame(server, "/go", token)
  expect(go.status).toBe(307)
  expect(go.headers.get("cache-control")).toBe("private, no-store")
  expect(go.headers.get("location")).toBe(`${origin}/frame-page?from=go&vitehub-content-preview=1#intro`)
  const landed = await postFrame(server, "/frame-page?from=go&vitehub-content-preview=1", token)
  expect(landed.status).toBe(200)
  expect(titleOf(await landed.text())).toBe("On screen")

  const web = await followFrame(server, "/go-web", token)
  expect(web.locations).toEqual([`${origin}/web-page?vitehub-content-preview=1`])
  expect(titleOf(await web.response.text())).toBe("On screen")

  // The redirect gives the browser its cookies. The next post carries what the browser sends, and nothing else.
  const login = await postFrame(server, "/login", token, { cookie: "prefs=1" })
  expect(login.status).toBe(307)
  expect(login.headers.get("location")).toBe(`${origin}/account?vitehub-content-preview=1`)
  expect(login.headers.getSetCookie().map(cookie => cookie.split(";", 1)[0])).toEqual(["session=abc123", "theme=dark"])
  expect((await postFrame(server, "/account?vitehub-content-preview=1", token, { cookie: "prefs=1" })).status).toBe(401)
  const account = await (await postFrame(server, "/account?vitehub-content-preview=1", token, { cookie: "prefs=1; session=abc123" })).text()
  expect(titleOf(account)).toBe("On screen")
  expect(account).toContain(`<p id="session">abc123</p><p id="frame">hello</p><p id="cookie">prefs=1; session=abc123</p><p id="method">GET</p><p id="type"></p>`)

  // Outside a frame, the same Cookie header gets the ordinary redirect with its cookies and public headers.
  const outside = await server.fetch("/login", { redirect: "manual", headers: { cookie: "prefs=1" } })
  expect(outside.status).toBe(302)
  expect(outside.headers.get("location")).toBe("/account")
  expect(outside.headers.getSetCookie().map(cookie => cookie.split(";", 1)[0])).toEqual(["session=abc123", "theme=dark"])
  expect(outside.headers.get("cache-control")).not.toBe("private, no-store")
  const normal = await server.fetch("/account", { headers: { cookie: "session=abc123" } })
  expect(titleOf(await normal.text())).toBe("Published")

  for (const path of ["/away", "/away-local", "/invalid"]) {
    const refused = await postFrame(server, path, token)
    expect(refused.status).toBe(502)
    expect(refused.headers.get("location")).toBeNull()
    expect(await refused.text()).toContain(`<meta name="vitehub-content-preview-error"`)
  }
  const loop = await followFrame(server, "/loop", token)
  expect(loop.locations).toEqual([1, 2, 3, 4, 5].map(hop => `${origin}/loop?vitehub-content-preview=${hop}`))
  expect(loop.response.status).toBe(502)
  expect(await loop.response.text()).toContain("redirects more than 5 times")

  // Frames and ordinary reads of the same pages at once stay apart.
  const reads = await Promise.all(Array.from({ length: 12 }, async (_, index) => index % 2
    ? { frame: false, title: titleOf(await (await server.fetch("/frame-page")).text()) }
    : { frame: true, title: titleOf(await (await followFrame(server, "/go", token)).response.text()) }))
  for (const read of reads) expect(read.title).toBe(read.frame ? "On screen" : "Published")
  return token
}

/** Sends a frame form of `size` bytes to the server, all at once with its length or in chunks without one. */
function upload(server: BuiltServer, size: number, chunked: boolean): Promise<{ status?: number, sent: number, closed: boolean, ms: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    let sent = 0
    let status: number | undefined
    let finished = false
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }
    if (!chunked) headers["content-length"] = String(size)
    const request = httpRequest({ host: "127.0.0.1", port: server.port, method: "POST", path: "/frame-page?vitehub-content-preview", headers }, (response) => {
      status = response.statusCode
      response.resume()
      response.on("end", () => done(true))
    })
    const done = (closed: boolean) => {
      if (finished) return
      finished = true
      clearInterval(timer)
      request.destroy()
      resolve({ status, sent, closed, ms: Date.now() - started })
    }
    request.on("error", () => done(true))
    request.on("close", () => done(true))
    const chunk = new Uint8Array(64 * 1024).fill(0x61)
    if (!chunked) {
      request.end(new Uint8Array(size).fill(0x61))
      sent = size
    }
    const timer = setInterval(() => {
      if (!chunked) return
      if (sent >= size) {
        request.end()
        return
      }
      sent += chunk.byteLength
      request.write(chunk)
    }, 2)
    setTimeout(() => done(false), 10_000)
  })
}

/**
 * Frame forms over 1 MiB on a direct Node server: one with an honest `Content-Length`, and a chunked one without a
 * length. Each gets a 403 or a closed connection within seconds, without the server reading the rest, and the server
 * keeps answering.
 */
export async function expectBoundedFrameUploads(server: BuiltServer, expect: typeof import("vitest").expect): Promise<void> {
  for (const chunked of [false, true]) {
    const result = await upload(server, 4 * 1024 * 1024, chunked)
    expect(result.closed).toBe(true)
    if (result.status !== undefined) expect(result.status).toBe(403)
    expect(result.ms).toBeLessThan(10_000)
    expect((await server.fetch("/frame-page")).status).toBe(200)
  }
}
