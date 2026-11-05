import type { Browser, BrowserContext, Cookie, Page, Request } from "playwright-core"

import type { BuiltServer } from "./content-preview-fixture.ts"

/** The part of the DOM that the page functions below use. They run in Chromium; this program has no DOM lib. */
interface PageElement {
  name: string
  method: string
  action: string
  target: string
  type: string
  value: string
  textContent: string | null
  append(...nodes: PageElement[]): void
  getAttribute(name: string): string | null
  remove(): void
  submit(): void
}
declare const document: {
  body: PageElement
  createElement(tag: string): PageElement
  getElementById(id: string): PageElement | null
  querySelector(selector: string): PageElement | null
}
declare const location: { pathname: string, search: string, hash: string }

/** Set `CONTENT_PREVIEW_BROWSER=1` to run the Chromium checks of the built apps. CI has no browser for them. */
export const browserChecks = process.env.CONTENT_PREVIEW_BROWSER === "1"

/** What the frame shows after its form and every redirect, read the way the Console reads it. */
interface FrameResult {
  error?: string
  title?: string
  body?: string
  other?: string
  cookie?: string
  method?: string
  type?: string
  frame?: string
  address: string
}

/** One request of a frame chain, as Chromium sent it. */
interface Sent {
  url: string
  method: string
  form: boolean
  seenCookie?: string
  hopTitle?: string
  status?: number
}

/** The cookies of a context, without the fields that change between two runs, such as expiry times. */
function jar(cookies: Cookie[]): string[] {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}; Path=${cookie.path}; HttpOnly=${cookie.httpOnly}; Secure=${cookie.secure}; Session=${cookie.expires === -1}`).sort()
}

/**
 * Posts the preview frame form into a new iframe of a same-origin page, as the Console does, and reads the page the
 * frame lands on: the error message of `<meta name="vitehub-content-preview-error">`, or the fixture page fields.
 */
async function frame(page: Page, origin: string, path: string, token: string): Promise<FrameResult> {
  const value = JSON.stringify({ token, document: { collection: "posts", id: "hello", data: { title: "On screen" }, body: "# On screen\n\nUnsaved body." } })
  const action = new URL(path, origin)
  action.searchParams.set("vitehub-content-preview", "")
  const name = `frame-${Math.random().toString(36).slice(2)}`
  await page.evaluate(({ action, name, value }) => {
    const iframe = document.createElement("iframe")
    iframe.name = name
    document.body.append(iframe)
    const form = document.createElement("form")
    form.method = "post"
    form.action = action
    form.target = name
    const input = document.createElement("input")
    input.type = "hidden"
    input.name = "vitehub-content-preview"
    input.value = value
    form.append(input)
    document.body.append(form)
    form.submit()
    form.remove()
  }, { action: action.href, name, value })
  const child = await (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = page.frame({ name })
      if (found && found.url() !== "about:blank" && found.url() !== "") return found
      await page.waitForTimeout(50)
    }
    throw new Error(`The frame for ${path} did not navigate.`)
  })()
  await child.waitForLoadState("load")
  return await child.evaluate(() => {
    const text = (id: string) => document.getElementById(id)?.textContent ?? undefined
    const error = document.querySelector("meta[name=\"vitehub-content-preview-error\"]")?.getAttribute("content") ?? undefined
    return {
      ...(error === undefined ? {} : { error }),
      ...(document.querySelector("h1") ? { title: document.querySelector("h1")!.textContent ?? "" } : {}),
      body: text("body"),
      other: text("other"),
      cookie: text("cookie"),
      method: text("method"),
      type: text("type"),
      frame: text("frame"),
      address: `${location.pathname}${location.search}${location.hash}`,
    }
  })
}

/** Records each request the context sends, with the headers its answer gives: which cookies a hop saw, and its title. */
function record(context: BrowserContext): Sent[] {
  const sent: Sent[] = []
  const entries = new Map<Request, Sent>()
  context.on("request", (request) => {
    if (!request.isNavigationRequest()) return
    const entry = { url: request.url(), method: request.method(), form: (request.postData() ?? "").includes("vitehub-content-preview=") }
    entries.set(request, entry)
    sent.push(entry)
  })
  context.on("response", (response) => {
    const entry = entries.get(response.request())
    if (!entry) return
    entry.status = response.status()
    const headers = response.headers()
    if (headers["x-seen-cookie"] !== undefined) entry.seenCookie = headers["x-seen-cookie"]
    if (headers["x-frame-title"] !== undefined) entry.hopTitle = headers["x-frame-title"]
  })
  return sent
}

/** Visits the routes that set the cookies of the checks, so the browser keeps them with their own paths. */
async function seed(context: BrowserContext, origin: string): Promise<void> {
  const page = await context.newPage()
  for (const path of ["/admin/set", "/set-root", "/deep/set"]) await page.goto(`${origin}${path}`)
  await page.close()
}

/** Follows the same chain with an ordinary top-level navigation, in its own context, and returns the cookies after it. */
async function ordinary(browser: Browser, origin: string, path: string): Promise<{ cookie?: string, title?: string, jar: string[] }> {
  const context = await browser.newContext()
  try {
    await seed(context, origin)
    const page = await context.newPage()
    await page.goto(`${origin}${path}`)
    const read = await page.evaluate(() => ({ cookie: document.getElementById("cookie")?.textContent ?? undefined, title: document.querySelector("h1")?.textContent ?? undefined }))
    return { ...read, jar: jar(await context.cookies()) }
  }
  finally {
    await context.close()
  }
}

/**
 * Chromium checks of preview frame redirects on a built app: the browser re-posts the form on each same-origin
 * redirect, selects cookies by path itself, and never sends the form away from the origin. Each chain also runs as
 * an ordinary navigation in a fresh context, and both end with the same cookies. Returns the number of checks.
 */
export async function expectBrowserFrameRedirects(server: BuiltServer, token: string, expect: typeof import("vitest").expect, extraPaths: string[] = []): Promise<number> {
  const { chromium } = await import("playwright-core")
  const origin = `http://127.0.0.1:${server.port}`
  const browser = await chromium.launch({ headless: true })
  let checks = 0
  const check = (callback: () => void) => {
    callback()
    checks++
  }
  try {
    /** Runs one frame in a fresh context with the seeded cookies, and the same chain as an ordinary navigation. */
    const run = async (path: string) => {
      const context = await browser.newContext()
      try {
        await seed(context, origin)
        const sent = record(context)
        const all: string[] = []
        context.on("request", request => void all.push(`${request.method()} ${request.url()}`))
        const page = await context.newPage()
        await page.goto(`${origin}/echo`)
        sent.length = 0
        const result = await frame(page, origin, path, token)
        await page.waitForTimeout(500)
        return { result, sent, all, jar: jar(await context.cookies()) }
      }
      finally {
        await context.close()
      }
    }
    const privateValues = [token, "On screen", "On%20screen", "On+screen", "Unsaved"]
    /** `hops`: the redirects of the chain answer with the fixture hop headers. */
    const expectChain = (sent: Sent[], hops = true) => {
      for (const entry of sent) {
        // Every request of the chain is the form POST, and no URL holds the token or the document.
        expect(entry).toMatchObject({ method: "POST", form: true })
        for (const value of privateValues) expect(entry.url).not.toContain(value)
        // Every redirect hop read the posted document.
        if (hops && entry.status === 307) expect(entry.hopTitle).toBe("On screen")
      }
    }

    // 1. An HttpOnly cookie for /admin reaches /admin/frame and never the /echo page it redirects to.
    const admin = await run("/admin/frame")
    check(() => expect(admin.sent.map(entry => [new URL(entry.url).pathname, entry.status])).toEqual([["/admin/frame", 307], ["/echo", 200]]))
    check(() => expect(admin.sent[0]!.seenCookie).toContain("admin=secret"))
    check(() => expect(admin.result.cookie).not.toContain("admin="))
    check(() => expect(admin.result.cookie).toBe("pref=root; gone=1"))
    check(() => expect(admin.result).toMatchObject({ title: "On screen", body: "# On screen\n\nUnsaved body.", other: "Other published", frame: "hello", method: "GET", type: "", address: "/echo?vitehub-content-preview=1" }))
    check(() => expectChain(admin.sent))
    const adminEcho = await run("/admin/echo")
    check(() => expect(adminEcho.result.cookie).toContain("admin=secret"))

    // 2. A Path=/ session survives a sign-in, a locale, and an absolute canonical redirect; the /admin cookie of the
    // redirect is set for /admin only.
    const signIn = await run("/sign-in")
    check(() => expect(signIn.sent.map(entry => `${entry.status} ${new URL(entry.url).pathname}${new URL(entry.url).search}`)).toEqual([
      "307 /sign-in?vitehub-content-preview=",
      "307 /locale?vitehub-content-preview=1",
      "307 /en/canonical?x=a%20b&flag&vitehub-content-preview=2",
      "200 /echo?lang=en&vitehub-content-preview=3",
    ]))
    check(() => expect(signIn.sent[1]!.seenCookie).toContain("session=s1"))
    check(() => expect(signIn.result.cookie).toBe("pref=root; gone=1; session=s1"))
    check(() => expect(signIn.result).toMatchObject({ title: "On screen", other: "Other published", address: "/echo?lang=en&vitehub-content-preview=3#intro" }))
    check(() => expect(signIn.jar).toContain("scoped=1; Path=/admin; HttpOnly=false; Secure=false; Session=true"))
    check(() => expectChain(signIn.sent))
    const signInOrdinary = await ordinary(browser, origin, "/sign-in")
    check(() => expect(signIn.jar).toEqual(signInOrdinary.jar))
    check(() => expect(signIn.result.cookie).toBe(signInOrdinary.cookie))

    // 3. Two cookies of the same name keep their paths and the browser's order, more specific path first.
    const deep = await run("/deep/start")
    check(() => expect(deep.result.cookie).toBe("pref=deep; pref=root; gone=1"))
    const out = await run("/deep/out")
    check(() => expect(out.sent[0]!.seenCookie).toBe("pref=deep; pref=root; gone=1"))
    check(() => expect(out.result.cookie).toBe("pref=root; gone=1"))
    const deepOrdinary = await ordinary(browser, origin, "/deep/start")
    const outOrdinary = await ordinary(browser, origin, "/deep/out")
    check(() => expect([deep.result.cookie, out.result.cookie]).toEqual([deepOrdinary.cookie, outOrdinary.cookie]))
    check(() => expect([deep.jar, out.jar]).toEqual([deepOrdinary.jar, outOrdinary.jar]))
    // Prefix rules and expiry stay with the browser, as on an ordinary redirect.
    const prefixes = await run("/prefixes")
    const prefixesOrdinary = await ordinary(browser, origin, "/prefixes")
    check(() => expect(prefixes.jar).toEqual(prefixesOrdinary.jar))
    check(() => expect(prefixes.result.cookie).toBe(prefixesOrdinary.cookie))
    check(() => expect(prefixes.jar.some(cookie => cookie.startsWith("gone="))).toBe(false))
    check(() => expect(prefixes.jar.some(cookie => cookie.startsWith("__Host-bad=") || cookie.startsWith("__Secure-bad="))).toBe(false))
    check(() => expect(prefixes.result.title).toBe("On screen"))

    // 4 and 5. Another origin of the same server, a Location that is not valid, and a loop get the error page; the
    // browser never posts the form to the other origin.
    for (const path of ["/away-local", "/invalid", "/loop", "/away"]) {
      const refused = await run(path)
      check(() => expect(refused.result.error).toBeTruthy())
      check(() => expect(refused.sent.every(entry => new URL(entry.url).origin === origin)).toBe(true))
      check(() => expectChain(refused.sent, path === "/away-local" || path === "/invalid"))
      if (path === "/loop") check(() => expect(refused.sent).toHaveLength(6))
    }

    // Host redirect shapes such as route rules and navigateTo(), relative and absolute. The page keeps the document
    // after it hydrates.
    for (const path of ["/go", "/go-web", ...extraPaths]) {
      const landed = await run(path)
      check(() => expect(landed.result, JSON.stringify({ path, all: landed.all, result: landed.result })).toMatchObject({ title: "On screen" }))
      check(() => expectChain(landed.sent, false))
    }

    // An ordinary tab of the same browser keeps reading published with the same cookies.
    const context = await browser.newContext()
    try {
      await seed(context, origin)
      const page = await context.newPage()
      await page.goto(`${origin}/sign-in`)
      check(() => expect(page.url()).toBe(`${origin}/echo?lang=en#intro`))
      const read = await page.evaluate(() => ({ title: document.querySelector("h1")?.textContent, other: document.getElementById("other")?.textContent }))
      check(() => expect(read).toEqual({ title: "Published", other: "Other published" }))
    }
    finally {
      await context.close()
    }
  }
  finally {
    await browser.close()
  }
  return checks
}
