// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import { loadViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"
import { afterEach, expect, it, vi } from "vitest"
import { createMemoryHistory, createRouter, isNavigationFailure } from "vue-router"

import start, { consolePageUrl, draftChanges, draftSwitch, isDraftView, liveUrl } from "../src/console/page/tool.ts"

it("remembers only the document actually opened when a leave guard cancels navigation", async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/content/:collection/:id", component: {} }],
  })
  const postMessage = vi.fn()
  const client = readFileSync(`${import.meta.dirname}/../src/console/runtime/client/main.js`, "utf8")
  const embed = client.slice(client.indexOf("// Only the same-origin parent"))
  runInNewContext(embed, {
    router,
    window: { parent: { postMessage }, addEventListener: vi.fn() },
    location: { origin: "http://site.test" },
  })

  await router.push("/content/pages/first?embed=1")
  expect(postMessage).toHaveBeenCalledWith({ type: "vitehub:route", path: "/content/pages/first?embed=1" }, "http://site.test")
  const removeGuard = router.beforeEach(() => false)
  postMessage.mockClear()
  const failure = await router.push("/content/pages/second?embed=1")
  expect(isNavigationFailure(failure)).toBe(true)
  expect(router.currentRoute.value.fullPath).toBe("/content/pages/first?embed=1")
  expect(postMessage.mock.calls.filter(([message]) => message.type === "vitehub:route")).toEqual([])

  removeGuard()
  await router.push("/content/pages/second?embed=1")
  expect(postMessage).toHaveBeenCalledWith({ type: "vitehub:route", path: "/content/pages/second?embed=1" }, "http://site.test")
})

afterEach(() => {
  document.querySelector("vitehub-pill")?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Turn off ViteHub tools"]')?.click()
  for (const element of document.querySelectorAll("vitehub-tools-off")) element.remove()
  localStorage.removeItem("vitehub-tools-off")
  history.replaceState(null, "", "/")
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([false, true])("keeps Content field selection styles through head and body swaps (selecting: %s)", async (selecting) => {
  history.replaceState(null, "", "/?vitehub=content")
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tools: [
    { id: "content", label: "Content", script: "/_vitehub/assets/page-tool.js" },
  ] })))
  await loadViteHubPageTools({ load: async () => ({ default: start }) })
  const select = document.querySelector("vitehub-tool")!.shadowRoot!.querySelectorAll("button")[1]!
  if (selecting) select.click()
  const style = [...document.head.querySelectorAll("style")].find(element => element.textContent?.includes(".vitehub-select-content"))!
  const before = document.body
  const head = document.head
  const next = document.createElement("body")
  const nextHead = document.createElement("head")
  next.innerHTML = '<h1 data-content-field="pages:next#title">Next page</h1>'
  try {
    document.documentElement.className = "next-page"
    head.replaceWith(nextHead)
    before.replaceWith(next)
    await vi.waitFor(() => {
      expect(style.parentElement).toBe(nextHead)
      expect(document.documentElement.classList.contains("vitehub-select-content")).toBe(selecting)
    })
    expect(document.documentElement.classList.contains("next-page")).toBe(true)
    // Turbo can remove a head stylesheet while retaining the head itself.
    style.remove()
    await vi.waitFor(() => expect(style.parentElement).toBe(nextHead))
    if (!selecting) select.click()
    expect(document.documentElement.classList.contains("vitehub-select-content")).toBe(true)
    document.querySelector("vitehub-pill")!.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Turn off ViteHub tools"]')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(style.isConnected).toBe(false)
    expect(document.documentElement.classList.contains("vitehub-select-content")).toBe(false)
  }
  finally {
    next.replaceWith(before)
    nextHead.replaceWith(head)
    document.documentElement.className = ""
  }
})

it("opens and minimizes the retained Console window when Trusted Types blocks HTML sinks", async () => {
  vi.spyOn(ShadowRoot.prototype, "innerHTML", "set").mockImplementation(() => {
    throw new TypeError("This document requires 'TrustedHTML' assignment.")
  })
  history.replaceState(null, "", "/?vitehub")
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tools: [
    { id: "console", label: "Console", icon: "i-lucide-square-terminal", script: "/_vitehub/assets/page-tool.js" },
  ] })))
  await loadViteHubPageTools({ load: async () => ({ default: start }) })

  const bar = document.querySelector("vitehub-tool")!
  const button = bar.shadowRoot!.querySelector("button")!
  expect(button.textContent).toBe("Console")
  expect(button.getAttribute("aria-haspopup")).toBe("dialog")
  const pageWindow = document.querySelector<HTMLElement>("vitehub-window")!
  expect(pageWindow.hidden).toBe(true)
  button.click()
  expect(pageWindow.hidden).toBe(false)
  expect(button.getAttribute("aria-expanded")).toBe("true")
  const frame = pageWindow.shadowRoot!.querySelector("iframe")!
  expect(frame.title).toBe("Console editor")
  expect(new URL(frame.src).searchParams.get("embed")).toBe("1")
  expect(pageWindow.shadowRoot!.querySelector("svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg")
  pageWindow.shadowRoot!.querySelector<HTMLButtonElement>(".hide")!.click()
  expect(pageWindow.hidden).toBe(true)
  button.click()
  expect(pageWindow.shadowRoot!.querySelector("iframe")).toBe(frame)
})

it("moves the Content window out of the way while a field is selected, and brings it back on a cancel", async () => {
  history.replaceState(null, "", "/?vitehub=content")
  document.body.insertAdjacentHTML("beforeend", `<h1 data-content-field="pages:travel#title">Flying</h1><a href="#elsewhere">Elsewhere</a>`)
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tools: [
    { id: "content", label: "Content", icon: "i-lucide-file-pen", script: "/_vitehub/assets/page-tool.js" },
  ] })))
  await loadViteHubPageTools({ load: async () => ({ default: start }) })
  const [content, select] = [...document.querySelector("vitehub-tool")!.shadowRoot!.querySelectorAll("button")]
  const pageWindow = document.querySelector<HTMLElement>("vitehub-window")!
  const state = () => [pageWindow.hidden, select!.getAttribute("aria-pressed"), document.documentElement.classList.contains("vitehub-select-content")]
  const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  try {
    expect([content!.textContent, select!.textContent]).toEqual(["Content", "Select field"])
    expect(pageWindow.hidden).toBe(false)

    // Open window: selecting minimizes it, and Esc, a second click, or a click outside a field restores it.
    select!.click()
    expect(state()).toEqual([true, "true", true])
    escape()
    expect(state()).toEqual([false, "false", false])
    select!.click()
    select!.click()
    expect(state()).toEqual([false, "false", false])
    select!.click()
    const link = document.querySelector("a")!
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(state()).toEqual([false, "false", false])

    // A picked field opens in the restored window.
    select!.click()
    document.querySelector("h1")!.click()
    expect(state()).toEqual([false, "false", false])

    // Minimized window: it stays minimized while selecting and after a cancel, and only a picked field opens it.
    pageWindow.shadowRoot!.querySelector<HTMLButtonElement>(".hide")!.click()
    select!.click()
    expect(state()).toEqual([true, "true", true])
    escape()
    expect(state()).toEqual([true, "false", false])
    select!.click()
    document.querySelector("h1")!.click()
    expect(state()).toEqual([false, "false", false])
  }
  finally { for (const element of document.querySelectorAll("h1, a")) element.remove() }
})

it.each([
  ["/schedules?embed=1&record=definition:content-publish#runs", "http://site.test/_vitehub/schedules?record=definition:content-publish#runs"],
  ["/content/posts/hello?panel=history&embed=1&q=a%20b", "http://site.test/_vitehub/content/posts/hello?panel=history&q=a%20b"],
  ["/?embed=1", "http://site.test/_vitehub/"],
])("opens %s in a full tab without the frame mode", (route, href) => {
  expect(consolePageUrl("/_vitehub", route, "http://site.test")).toBe(href)
})

it("links the window and the load fallback to the page that the window shows", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  try {
    history.replaceState(null, "", "/?vitehub")
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tools: [
      { id: "console", label: "Console", icon: "i-lucide-square-terminal", script: "/_vitehub/assets/page-tool.js" },
    ] })))
    await loadViteHubPageTools({ load: async () => ({ default: start }) })
    document.querySelector("vitehub-tool")!.shadowRoot!.querySelector("button")!.click()
    const shadow = document.querySelector<HTMLElement>("vitehub-window")!.shadowRoot!
    const link = shadow.querySelector<HTMLAnchorElement>('header a[aria-label="Open in new tab"]')!
    const frame = shadow.querySelector("iframe")!
    vi.advanceTimersByTime(8000)
    const fallback = shadow.querySelector<HTMLAnchorElement>(".loading a.shown")!
    expect(fallback.href).toBe(link.href)
    expect(new URL(link.href).searchParams.has("embed")).toBe(false)

    // The Console reports each route with its query, and the link follows it.
    dispatchEvent(new MessageEvent("message", { origin: location.origin, source: frame.contentWindow, data: { type: "vitehub:route", path: "/schedules?embed=1&record=definition:nightly" } }))
    link.dispatchEvent(new FocusEvent("focus"))
    expect(link.getAttribute("href")).toMatch(/^http:\/\/[^?]+\/schedules\?record=definition:nightly$/)
  }
  finally { vi.useRealTimers() }
})

/** Answers the page tools session with the Content tool, and Content actions with `answers`. */
function contentFetch(answers: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/rpc/__call")) return Response.json({ tools: [{ id: "content", label: "Content", icon: "i-lucide-file-pen", script: "/_vitehub/assets/page-tool.js" }] })
    const { input: call } = JSON.parse(String(init?.body)) as { input: { action: string, body: Record<string, unknown>, section: string } }
    return Response.json({ ok: true, value: answers[call.action] ?? null })
  })
}

function viewDraft() {
  return document.querySelector("vitehub-tool")!.shadowRoot!.querySelector<HTMLButtonElement>("button.view-draft")!
}

it("offers the draft of the open page and posts its preview form to the same page", async () => {
  history.replaceState(null, "", "/blog/hello?vitehub&tab=1")
  const fetch = contentFetch({ resolve: { collection: "posts", id: "hello", state: "changed" }, preview: { parameter: "vitehub-content-preview", token: "f1.token", expiresAt: "2026-11-04T00:15:00.000Z" } })
  vi.stubGlobal("fetch", fetch)
  const submitted: Array<{ action: string, method: string, value: string | undefined }> = []
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
    submitted.push({ action: this.action, method: this.method, value: this.querySelector("input")?.value })
  })
  await loadViteHubPageTools({ load: async () => ({ default: start }) })

  const view = viewDraft()
  await vi.waitFor(() => expect(view.hidden).toBe(false))
  expect(view.textContent).toBe("View draft")
  expect(document.querySelector("vitehub-draft-banner")).toBeNull()
  const resolveCall = fetch.mock.calls.find(([url]) => String(url).endsWith("/rpc/__call"))!
  expect(JSON.parse(String(resolveCall[1]!.body))).toEqual({ operation: "documents.action", input: { action: "resolve", body: { path: "/blog/hello" }, section: "content" } })

  view.click()
  await vi.waitFor(() => expect(submitted).toHaveLength(1))
  const url = new URL(submitted[0]!.action)
  expect([url.pathname, url.searchParams.get("tab"), url.searchParams.has("vitehub-content-preview"), submitted[0]!.method]).toEqual(["/blog/hello", "1", true, "post"])
  // The token travels in the form body only, and the page shows the stored draft.
  expect(JSON.parse(submitted[0]!.value!)).toEqual({ token: "f1.token" })
  expect(url.href).not.toContain("f1.token")
  expect(document.querySelector("form")).toBeNull()
})

it.each(["", "/portal", "/portal/nested"])("resolves draft documents below the app base %j on load and navigation", async (appBase) => {
  history.replaceState(null, "", `${appBase}/blog/hello?vitehub`)
  const fetch = contentFetch({ resolve: { collection: "posts", id: "hello", state: "changed" } })
  vi.stubGlobal("fetch", fetch)
  const base = `${appBase}/_vitehub`
  const shadow = document.createElement("div").attachShadow({ mode: "open" })
  const controller = new AbortController()
  const resolved = (path: string) => expect(fetch).toHaveBeenLastCalledWith(`${base}/rpc/__call`, expect.objectContaining({
    body: JSON.stringify({ operation: "documents.action", input: { action: "resolve", body: { path }, section: "content" } }),
  }))
  try {
    draftSwitch(base, shadow, controller.signal)
    await vi.waitFor(() => expect(shadow.querySelector<HTMLButtonElement>("button.view-draft")!.hidden).toBe(false))
    resolved("/blog/hello")

    history.pushState(null, "", appBase || "/")
    await vi.waitFor(() => resolved("/"))
  }
  finally { controller.abort() }
})

it("hides View draft on pages without an unpublished draft, and resolves again after client navigation", async () => {
  history.replaceState(null, "", "/blog/hello?vitehub")
  const answers: Record<string, unknown> = { resolve: { collection: "posts", id: "hello", state: "published" } }
  const fetch = contentFetch(answers)
  vi.stubGlobal("fetch", fetch)
  await loadViteHubPageTools({ load: async () => ({ default: start }) })
  const view = viewDraft()
  const resolves = () => fetch.mock.calls.filter(([url]) => String(url).endsWith("/rpc/__call")).length
  await vi.waitFor(() => expect(resolves()).toBe(1))
  expect(view.hidden).toBe(true)

  // A scroll-position update keeps the path, so it does not ask again.
  history.replaceState({ scroll: 1 }, "", "/blog/hello?vitehub")
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(resolves()).toBe(1)

  answers.resolve = { collection: "posts", id: "later", state: "draft" }
  history.pushState(null, "", "/blog/later")
  await vi.waitFor(() => expect(view.hidden).toBe(false))
  expect(resolves()).toBe(2)

  answers.resolve = null
  history.pushState(null, "", "/about")
  await vi.waitFor(() => expect(resolves()).toBe(3))
  expect(view.hidden).toBe(true)
})

it.each([false, true])("stops Content navigation tracking on exit with a later History wrapper (removed: %s)", async (removed) => {
  const original = { pushState: history.pushState, replaceState: history.replaceState }
  history.replaceState(null, "", "/blog/hello?vitehub")
  const fetch = contentFetch({ resolve: { collection: "posts", id: "hello", state: "published" } })
  vi.stubGlobal("fetch", fetch)
  try {
    await loadViteHubPageTools({ load: async () => ({ default: start }) })
    await vi.waitFor(() => expect(viewDraft().hidden).toBe(true))
    const calls = fetch.mock.calls.length
    const content = { pushState: history.pushState, replaceState: history.replaceState }
    const later = { ...content }
    for (const method of ["pushState", "replaceState"] as const) {
      later[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        return content[method].apply(this, args)
      }
      history[method] = later[method]
    }

    // A navigation queued just before exit must not resolve after the signal aborts either.
    history.pushState(null, "", "/blog/queued")
    document.querySelector("vitehub-pill")!.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Turn off ViteHub tools"]')!.click()
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(calls)
    for (const method of ["pushState", "replaceState"] as const) {
      expect(history[method]).toBe(later[method])
      // Comments restores its saved method when its controller aborts after Content's.
      if (removed) history[method] = content[method]
    }

    history.pushState({ page: 1 }, "", "/blog/next")
    history.replaceState({ page: 2 }, "", "/blog/final")
    await Promise.resolve()
    expect(location.pathname).toBe("/blog/final")
    expect(history.state).toEqual({ page: 2 })
    expect(fetch).toHaveBeenCalledTimes(calls)
  }
  finally {
    history.pushState = original.pushState
    history.replaceState = original.replaceState
  }
})

it("shows the draft banner instead of View draft in the draft view, and removes it after leaving", async () => {
  history.replaceState(null, "", "/blog/hello?vitehub-content-preview&vitehub&tab=1")
  vi.stubGlobal("fetch", contentFetch({ resolve: { collection: "posts", id: "hello", state: "changed" } }))
  // The change marks load the live page in a hidden frame. The browser check covers that load.
  const frames: string[] = []
  vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation((value: string) => { frames.push(value) })
  await loadViteHubPageTools({ load: async () => ({ default: start }) })
  expect(frames.map(value => new URL(value).search)).toEqual(["?vitehub=&tab=1&vitehub-content-published="])
  const banner = document.querySelector("vitehub-draft-banner")!
  expect(banner.shadowRoot!.textContent).toContain("Draft preview. Only you see this.")
  expect([...banner.shadowRoot!.querySelectorAll("button")].map(button => button.textContent)).toContain("Back to live")
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(viewDraft().hidden).toBe(true)
  expect(isDraftView(location.search)).toBe(true)
  expect(liveUrl("http://site.test/blog/hello?vitehub-content-preview=hop&tab=1#top")).toBe("http://site.test/blog/hello?tab=1#top")

  // A client-side link out of the draft view leaves the single document that the form granted.
  history.pushState(null, "", "/about")
  await vi.waitFor(() => expect(document.querySelector("vitehub-draft-banner")).toBeNull())
})

it("marks the draft blocks that the live page does not have", () => {
  const page = (html: string) => {
    const root = document.createElement("main")
    root.innerHTML = html
    return root
  }
  const live = page("<h1>Guide</h1><p>Start in Bangkok.</p><ul><li><p>Old tip</p></li><li>Same tip</li></ul><p>Gone soon.</p>")
  const draft = page("<h1>Guide 2026</h1><p>Same tip</p><p>Start in   Bangkok.</p><ul><li><p>New tip</p></li></ul><p>Watch the video.</p>")
  const { changed, removed } = draftChanges(draft, live)
  // Moved and reflowed text is not a change. The edited title and tip take the place of two live blocks.
  expect(changed.map(element => element.textContent)).toEqual(["Guide 2026", "New tip", "Watch the video."])
  expect(removed).toBe(0)
  expect(draftChanges(page("<p>Start in Bangkok.</p>"), live).removed).toBe(4)
})
