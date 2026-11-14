// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { loadViteHubPageTools, stopViteHubPageTools, viteHubPageToolsEdgeAt } from "../src/runtime/page-tools-loader.ts"
import { readViteHubPageSession, viteHubPageSessionUrl } from "../src/runtime/page-tools-shared.ts"

import type { ViteHubPageToolContext, ViteHubPageToolModule } from "../src/runtime/page-tools-loader.ts"

const comments = { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/comments.js" }
const consoleTool = { id: "console", label: "Console", icon: "i-lucide-square-terminal", hotkey: "k", script: "/console.js" }

/** Opens `path` on the test page with the hint cookie. */
function page(path: string) {
  history.replaceState(null, "", path)
  document.cookie = "vitehub-tools=1; Path=/"
}

function session(value: unknown, status = 200) {
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) => Response.json(value, { status }))
  vi.stubGlobal("fetch", fetch)
  return fetch
}

/** Tool modules by script URL. Each records the context that it got, and draws a button in its segment. */
function modules(draw: Record<string, boolean> = { comments: true, console: true }) {
  const started: ViteHubPageToolContext[] = []
  const stopped: string[] = []
  const tool = (id: string) => ({ default: (context: ViteHubPageToolContext) => {
    started.push(context)
    if (draw[id]) context.bar.attachShadow({ mode: "open" }).innerHTML = `<button>${context.tool.label}</button>`
    return () => stopped.push(id)
  } })
  const scripts: Record<string, unknown> = { "/comments.js": tool("comments"), "/console.js": tool("console") }
  const load = vi.fn(async (script: string) => scripts[script])
  return { load, started, stopped }
}

function pill() {
  const pills = document.querySelectorAll("vitehub-pill")
  expect(pills).toHaveLength(1)
  const element = pills[0]!
  const shadow = element.shadowRoot!
  return {
    element,
    slots: [...shadow.querySelectorAll("slot")].map(slot => slot.name),
    segments: [...element.children].map(child => [child.localName, child.getAttribute("slot"), child.hasAttribute("hidden")]),
    exit: shadow.querySelector<HTMLButtonElement>("button[aria-label=\"Turn off ViteHub tools\"]")!,
  }
}

/** The pill folds into its hexagon before the tools stop. Happy DOM runs no transition, so that takes one task. */
async function exited() {
  await new Promise(resolve => setTimeout(resolve))
}

function offMark() {
  const marks = document.querySelectorAll("vitehub-tools-off")
  expect(marks).toHaveLength(1)
  const element = marks[0]!
  return { element, button: element.shadowRoot!.querySelector<HTMLButtonElement>("button")! }
}

function lazyControl(): HTMLButtonElement {
  return document.querySelector("vitehub-tool")!.shadowRoot!.querySelector<HTMLButtonElement>("button")!
}

beforeEach(() => {
  // happy-dom has no layout and no `elementsFromPoint`: by default, nothing of the page is under the pill.
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, writable: true, value: () => [] })
  sessionStorage.clear()
  localStorage.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  stopViteHubPageTools()
  for (const element of document.querySelectorAll("vitehub-pill, vitehub-window, vitehub-tools-off")) element.remove()
  document.cookie = "vitehub-tools=; Path=/; Max-Age=0"
  document.documentElement.className = ""
  document.documentElement.removeAttribute("data-vitehub-pill")
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("loadViteHubPageTools", () => {
  it.each([
    ["?vitehub", "", 1],
    ["?vitehub=comments", "", 1],
    ["", "session=ada;vitehub-tools=1", 1],
    ["", "", 0],
    ["?other=1", "vitehub-tools=0", 0],
    ["", "vitehub_session=1", 1],
    ["", "vitehub_session=1; vitehub-tools=0", 0],
  ])("requests a session only with a hint (query %j, cookie %j)", async (search, cookie, calls) => {
    history.replaceState(null, "", `/${search}`)
    vi.spyOn(document, "cookie", "get").mockReturnValue(cookie)
    const fetch = session({ tools: [] })
    await expect(loadViteHubPageTools()).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it("starts tools and keeps exit usable when Trusted Types blocks HTML sinks", async () => {
    page("/?vitehub")
    session({ tools: [consoleTool] })
    vi.spyOn(ShadowRoot.prototype, "innerHTML", "set").mockImplementation(() => {
      throw new TypeError("This document requires 'TrustedHTML' assignment.")
    })
    const { load, started, stopped } = modules({ console: false })

    await expect(loadViteHubPageTools({ load })).resolves.toEqual([consoleTool])
    expect(started).toHaveLength(1)
    const { slots, exit } = pill()
    expect(slots).toEqual(["tab", "console"])
    expect(exit.querySelector("svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg")
    exit.click()
    await exited()
    expect(stopped).toEqual(["console"])
    expect(document.querySelector("vitehub-pill")).toBeNull()
  })

  it("asks the session route, then imports and starts only the allowed tools", async () => {
    page("/pricing?vitehub")
    const fetch = session({ tools: [comments] })
    const { load, started } = modules()
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([comments])
    expect(fetch).toHaveBeenCalledWith("/_vitehub/page/session?page=%2Fpricing", { credentials: "same-origin", headers: { accept: "application/json" } })
    expect(load.mock.calls).toEqual([["/comments.js"]])
    expect(started.map(context => [context.tool.id, context.open, context.signal.aborted])).toEqual([["comments", false, false]])
  })

  it("asks the session route below the app base of the loader", async () => {
    expect(viteHubPageSessionUrl("http://site.test/portal/_vitehub/page/assets/loader.js?v=9")).toBe("/portal/_vitehub/page/session")
    expect(viteHubPageSessionUrl("http://site.test/_vitehub/page/assets/loader.js?v=9")).toBe("/_vitehub/page/session")
    expect(viteHubPageSessionUrl("http://localhost:5173/src/loader.ts")).toBe("/_vitehub/page/session")
    page("/portal/?vitehub")
    const fetch = session({ tools: [] })
    await loadViteHubPageTools({ load: modules().load, session: "/portal/_vitehub/page/session" })
    expect(fetch).toHaveBeenCalledWith("/portal/_vitehub/page/session?page=%2Fportal%2F", { credentials: "same-origin", headers: { accept: "application/json" } })
  })

  it("does nothing more when no tool is allowed, or when the session fails", async () => {
    page("/")
    const { load } = modules()
    session({ tools: [] })
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    session({ error: { code: "VITEHUB_PAGE_TOOLS_CROSS_ORIGIN" } }, 403)
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    vi.stubGlobal("fetch", async () => { throw new TypeError("offline") })
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    expect(load).not.toHaveBeenCalled()
    expect(document.querySelector("vitehub-pill")).toBeNull()
  })

  it("mounts one pill with a segment per tool in session order, then the exit button", async () => {
    page("/?vitehub")
    session({ tools: [comments, consoleTool] })
    const { load, started } = modules()
    await loadViteHubPageTools({ load })
    const { element, slots, segments, exit } = pill()
    expect(element.parentElement).toBe(document.documentElement)
    expect(slots).toEqual(["tab", "comments", "console"])
    expect(segments).toEqual([["vitehub-tool", "comments", false], ["vitehub-tool", "console", false]])
    expect(started.map(context => context.bar)).toEqual([...element.children])
    expect(element.shadowRoot!.querySelector("[role=toolbar]")!.getAttribute("aria-label")).toBe("ViteHub tools")
    expect(exit.title).toBe("Turn off ViteHub tools")
    // A second loader on the same page leaves the pill alone.
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    pill()
  })

  it("gives a tool a tab outside the bar's clip, and removes it when the tools stop", async () => {
    page("/?vitehub")
    session({ tools: [consoleTool] })
    const { load, started } = modules()
    await loadViteHubPageTools({ load })
    const tab = started[0]!.createTab()
    const { element, segments, exit } = pill()
    expect(tab.parentElement).toBe(element)
    expect(segments).toEqual([["vitehub-tool", "console", false], ["vitehub-tab", "tab", false]])
    // The tab slot is a sibling of the bar, so the bar's clip and scroll do not cut the tab.
    const slot = element.shadowRoot!.querySelector<HTMLSlotElement>("slot[name=tab]")!
    expect(slot.parentNode).toBe(element.shadowRoot)
    expect(slot.assignedElements()).toEqual([tab])
    exit.click()
    await exited()
    expect(tab.isConnected).toBe(false)
  })

  it("collapses to the ViteHub mark, keeps the tools running, and remembers it on the next page", async () => {
    page("/?vitehub")
    session({ tools: [comments, consoleTool] })
    const first = modules()
    await loadViteHubPageTools({ load: first.load })
    const { element } = pill()
    const mark = element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!
    const toolbar = element.shadowRoot!.querySelector<HTMLElement>("[role=toolbar]")!
    toolbar.scrollLeft = 120
    expect([mark.getAttribute("aria-expanded"), mark.getAttribute("aria-label")]).toEqual(["true", "Hide ViteHub tools"])
    mark.click()
    expect(element.hasAttribute("collapsed")).toBe(true)
    expect(toolbar.scrollLeft).toBe(0)
    expect([mark.getAttribute("aria-expanded"), mark.getAttribute("aria-label")]).toEqual(["false", "Show ViteHub tools"])
    expect(first.stopped).toEqual([])

    element.remove()
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    expect(pill().element.hasAttribute("collapsed")).toBe(true)
    pill().element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!.click()
    expect(pill().element.hasAttribute("collapsed")).toBe(false)
    expect(localStorage.getItem("vitehub-tools-collapsed")).toBeNull()
  })

  it("folds to the mark at an end of its edge while the page asks, and stores nothing", async () => {
    page("/?vitehub")
    document.documentElement.setAttribute("data-vitehub-pill", "mark")
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    const mark = element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!
    expect([element.hasAttribute("collapsed"), element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual([true, "bottom", "100"])

    mark.click()
    expect([element.hasAttribute("collapsed"), element.style.getPropertyValue("--at")]).toEqual([false, "100"])
    expect([localStorage.getItem("vitehub-tools-collapsed"), localStorage.getItem("vitehub-tools-dock")]).toEqual([null, null])

    document.documentElement.removeAttribute("data-vitehub-pill")
    await vi.waitFor(() => expect(element.style.getPropertyValue("--at")).toBe("50"))
    expect(element.hasAttribute("collapsed")).toBe(false)
  })

  it("folds to the mark at an end of its edge when the page's own floating control is where it docks", async () => {
    page("/?vitehub")
    const menu = document.createElement("button")
    menu.style.position = "fixed"
    document.body.append(menu)
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 400, y: 700, width: 220, height: 56 }))
    const under = vi.fn((x: number, y: number) => (Math.abs(x - innerWidth / 2) <= 110 && y > innerHeight - 80 ? [menu, document.body, document.documentElement] : [document.body, document.documentElement]))
    vi.spyOn(document, "elementsFromPoint").mockImplementation(under)
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    expect([element.hasAttribute("collapsed"), element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual([true, "bottom", "100"])
    expect([localStorage.getItem("vitehub-tools-collapsed"), localStorage.getItem("vitehub-tools-dock")]).toEqual([null, null])
    menu.remove()
  })

  it("folds for a sticky bar that sticks to the bottom, but not for a heading that sticks to the top", async () => {
    page("/?vitehub")
    const heading = document.createElement("h2")
    heading.style.position = "sticky"
    heading.style.top = "0"
    // What a browser computes for an unset bottom. happy-dom leaves it empty.
    heading.style.bottom = "auto"
    const bar = document.createElement("div")
    bar.style.position = "sticky"
    bar.style.bottom = "0"
    document.body.append(heading, bar)
    for (const element of [heading, bar]) vi.spyOn(element, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: innerHeight - 56, width: innerWidth, height: 56 }))
    let under: Element = heading
    vi.spyOn(document, "elementsFromPoint").mockImplementation(() => [under, document.body, document.documentElement])
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    expect(pill().element.hasAttribute("collapsed")).toBe(false)

    pill().element.remove()
    under = bar
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    expect(pill().element.hasAttribute("collapsed")).toBe(true)
    heading.remove()
    bar.remove()
  })

  it("stays folded when the person drops the folded mark somewhere else", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    page("/?vitehub")
    const menu = document.createElement("button")
    menu.style.position = "fixed"
    document.body.append(menu)
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 400, y: 700, width: 220, height: 56 }))
    vi.spyOn(document, "elementsFromPoint").mockReturnValue([menu, document.body, document.documentElement])
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    expect(element.hasAttribute("collapsed")).toBe(true)
    // What a drop of the mark stores, then the pointerup that ends the drag.
    localStorage.setItem("vitehub-tools-dock", JSON.stringify({ edge: "right", at: 40 }))
    document.dispatchEvent(new PointerEvent("pointerup"))
    vi.advanceTimersByTime(250)
    expect(element.hasAttribute("collapsed")).toBe(true)
    vi.useRealTimers()
    menu.remove()
  })

  it("keeps the place where the person docked the pill, even over the page's floating control", async () => {
    page("/?vitehub")
    localStorage.setItem("vitehub-tools-dock", JSON.stringify({ edge: "bottom", at: 50 }))
    const menu = document.createElement("button")
    menu.style.position = "fixed"
    document.body.append(menu)
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 400, y: 700, width: 220, height: 56 }))
    vi.spyOn(document, "elementsFromPoint").mockReturnValue([menu, document.body, document.documentElement])
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    expect([element.hasAttribute("collapsed"), element.style.getPropertyValue("--at")]).toEqual([false, "50"])
    menu.remove()
  })

  it("folds when the page adds its floating control after the pill", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    page("/?vitehub")
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    expect(element.hasAttribute("collapsed")).toBe(false)
    // A chat widget that loads late.
    const menu = document.createElement("button")
    menu.style.position = "fixed"
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 400, y: 700, width: 220, height: 56 }))
    vi.spyOn(document, "elementsFromPoint").mockReturnValue([menu, document.body, document.documentElement])
    document.body.append(menu)
    await vi.advanceTimersByTimeAsync(250)
    expect([element.hasAttribute("collapsed"), element.style.getPropertyValue("--at")]).toEqual([true, "100"])
    menu.remove()
  })

  it("finds a small control that sits between the old sample points", async () => {
    page("/?vitehub")
    const top = document.createElement("button")
    top.style.position = "fixed"
    document.body.append(top)
    // A 44px button from 8px to 52px right of the middle.
    vi.spyOn(top, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: innerWidth / 2 + 8, y: innerHeight - 60, width: 44, height: 44 }))
    vi.spyOn(document, "elementsFromPoint").mockImplementation((x: number) => (x >= innerWidth / 2 + 8 && x <= innerWidth / 2 + 52 ? [top, document.body, document.documentElement] : [document.body, document.documentElement]))
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    expect(pill().element.hasAttribute("collapsed")).toBe(true)
    top.remove()
  })

  it("folds when the page shows a hidden control or a scroll reveals one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    page("/?vitehub")
    const menu = document.createElement("button")
    menu.style.position = "fixed"
    menu.hidden = true
    const list = document.createElement("div")
    document.body.append(menu, list)
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 400, y: 700, width: 220, height: 56 }))
    let revealed = false
    vi.spyOn(document, "elementsFromPoint").mockImplementation(() => (!menu.hidden || revealed ? [menu, document.body, document.documentElement] : [document.body, document.documentElement]))
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    expect(element.hasAttribute("collapsed")).toBe(false)
    menu.hidden = false
    await vi.advanceTimersByTimeAsync(250)
    expect(element.hasAttribute("collapsed")).toBe(true)
    menu.hidden = true
    await vi.advanceTimersByTimeAsync(250)
    expect(element.hasAttribute("collapsed")).toBe(false)
    // A scroll of an inner list, which does not bubble, shows the control without a change of the DOM.
    revealed = true
    list.dispatchEvent(new Event("scroll"))
    await vi.advanceTimersByTimeAsync(250)
    expect(element.hasAttribute("collapsed")).toBe(true)
    menu.remove()
  })

  it("folds for a small control in a fixed layer over the whole screen, but not for the layer", async () => {
    page("/?vitehub")
    const layer = document.createElement("div")
    layer.style.position = "fixed"
    const menu = document.createElement("button")
    layer.append(menu)
    document.body.append(layer)
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: innerWidth, height: innerHeight }))
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 400, y: 700, width: 220, height: 56 }))
    const under = vi.spyOn(document, "elementsFromPoint").mockReturnValue([layer, document.body, document.documentElement])
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    expect(pill().element.hasAttribute("collapsed")).toBe(false)
    pill().element.remove()
    under.mockReturnValue([menu, layer, document.body, document.documentElement])
    await loadViteHubPageTools({ load: modules().load })
    expect(pill().element.hasAttribute("collapsed")).toBe(true)
    layer.remove()
  })

  it("keeps the folded mark aside when another tab saves a dock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    page("/?vitehub")
    const menu = document.createElement("button")
    menu.style.position = "fixed"
    document.body.append(menu)
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 400, y: 700, width: 220, height: 56 }))
    vi.spyOn(document, "elementsFromPoint").mockReturnValue([menu, document.body, document.documentElement])
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    const dock = JSON.stringify({ edge: "left", at: 40 })
    localStorage.setItem("vitehub-tools-dock", dock)
    dispatchEvent(new StorageEvent("storage", { key: "vitehub-tools-dock", newValue: dock }))
    await vi.advanceTimersByTimeAsync(250)
    expect([element.hasAttribute("collapsed"), element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual([true, "bottom", "100"])
    expect(localStorage.getItem("vitehub-tools-collapsed")).toBe(null)
    menu.remove()
  })

  it("moves the focus from a hidden segment to the mark when the page asks for the mark", async () => {
    page("/?vitehub")
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    const control = document.querySelector("vitehub-tool")!.shadowRoot!.querySelector("button")!
    const focus = vi.spyOn(element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!, "focus")
    control.focus()
    document.documentElement.setAttribute("data-vitehub-pill", "mark")
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(element.hasAttribute("collapsed")).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
  })

  it("follows the page's ask after it loads, back to the person's own choices", async () => {
    page("/?vitehub")
    localStorage.setItem("vitehub-tools-dock", JSON.stringify({ edge: "bottom", at: 30 }))
    session({ tools: [comments, consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    expect([element.hasAttribute("collapsed"), element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual([false, "bottom", "30"])

    document.documentElement.setAttribute("data-vitehub-pill", "mark")
    await vi.waitFor(() => expect(element.hasAttribute("collapsed")).toBe(true))
    expect(element.style.getPropertyValue("--at")).toBe("0")
    // A page that sets the same value again, such as on a client-side navigation, keeps the pill as the person opened it.
    element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!.click()
    document.documentElement.setAttribute("data-vitehub-pill", "mark")
    await new Promise(resolve => setTimeout(resolve))
    expect(element.hasAttribute("collapsed")).toBe(false)

    document.documentElement.setAttribute("data-vitehub-pill", "")
    await vi.waitFor(() => expect(element.style.getPropertyValue("--at")).toBe("30"))
    expect(element.hasAttribute("collapsed")).toBe(false)
    document.documentElement.setAttribute("data-vitehub-pill", "mark")
    await vi.waitFor(() => expect(element.hasAttribute("collapsed")).toBe(true))
  })

  it.each([
    [{ edge: "top", at: 30 }, "30"],
    [{ edge: "left", at: 80 }, "80"],
  ] as const)("folds in place on an edge other than the bottom while the page asks (dock %j)", async (dock, at) => {
    page("/?vitehub")
    localStorage.setItem("vitehub-tools-dock", JSON.stringify(dock))
    document.documentElement.setAttribute("data-vitehub-pill", "mark")
    session({ tools: [consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    expect([element.hasAttribute("collapsed"), element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual([true, dock.edge, at])
  })

  it("opens the pill when the off mark turns the tools on, even while the page asks", async () => {
    page("/")
    localStorage.setItem("vitehub-tools-off", "1")
    document.documentElement.setAttribute("data-vitehub-pill", "mark")
    session({ tools: [consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    offMark().button.click()
    await vi.waitFor(() => expect(document.querySelector("vitehub-pill")).not.toBeNull())
    const { element } = pill()
    expect([element.hasAttribute("collapsed"), element.style.getPropertyValue("--at")]).toEqual([false, "100"])
    expect(localStorage.getItem("vitehub-tools-collapsed")).toBeNull()
  })

  it.each([
    [{ edge: "bottom", at: 40 }, "bottom", "0"],
    [{ edge: "right", at: 20 }, "right", "20"],
  ] as const)("moves the off mark aside while the page asks (dock %j)", async (dock, edge, at) => {
    page("/")
    localStorage.setItem("vitehub-tools-off", "1")
    localStorage.setItem("vitehub-tools-dock", JSON.stringify(dock))
    document.documentElement.setAttribute("data-vitehub-pill", "mark")
    session({ tools: [consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = offMark()
    expect([element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual([edge, at])
    document.documentElement.removeAttribute("data-vitehub-pill")
    await vi.waitFor(() => expect(element.style.getPropertyValue("--at")).toBe(String(dock.at)))
  })

  it("docks where the browser remembers, before it draws, and docks windows on the same edge", async () => {
    page("/?vitehub")
    localStorage.setItem("vitehub-tools-dock", JSON.stringify({ edge: "right", at: 20 }))
    session({ tools: [{ ...consoleTool, lazy: true }] })
    await loadViteHubPageTools({ load: async () => ({ default(context: ViteHubPageToolContext) {
      const trigger = document.createElement("button")
      context.bar.attachShadow({ mode: "open" }).append(trigger)
      context.createWindow({ id: "console", title: "Console", trigger }).show()
    } }) })
    const { element } = pill()
    expect([element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual(["right", "20"])
    lazyControl().click()
    await vi.waitFor(() => expect(document.querySelector("vitehub-window")).not.toBeNull())
    const host = document.querySelector<HTMLElement>("vitehub-window")!
    expect([host.getAttribute("edge"), host.style.getPropertyValue("--at")]).toEqual(["right", "20"])

    element.remove()
    localStorage.setItem("vitehub-tools-dock", JSON.stringify({ edge: "middle", at: 500 }))
    session({ tools: [consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    expect([pill().element.getAttribute("edge"), pill().element.style.getPropertyValue("--at")]).toEqual(["bottom", "50"])
  })

  it.each([
    [false, "top", 200, 10, 100, 5.1],
    [true, "top", 200, 10, 24 * 10 / 9, 8.2],
    [false, "left", 10, 200, 100, 11],
    [true, "left", 10, 200, 24, 16.5],
  ] as const)("accounts for asymmetric safe areas when dragging (collapsed: %s, edge: %s)", async (collapsed, edge, x, y, size, expected) => {
    page("/?vitehub")
    if (collapsed) localStorage.setItem("vitehub-tools-collapsed", "1")
    session({ tools: [consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    const mark = element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!
    const toolbar = element.shadowRoot!.querySelector<HTMLElement>('[role="toolbar"]')!
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1200)
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(676)
    vi.spyOn(toolbar, "offsetWidth", "get").mockReturnValue(size)
    vi.spyOn(toolbar, "offsetHeight", "get").mockReturnValue(size)
    vi.spyOn(element, "offsetWidth", "get").mockReturnValue(size)
    vi.spyOn(element, "offsetHeight", "get").mockReturnValue(size)
    vi.spyOn(mark, "offsetWidth", "get").mockReturnValue(size)
    vi.spyOn(mark, "offsetHeight", "get").mockReturnValue(size)
    vi.spyOn(mark, "getBoundingClientRect").mockReturnValue(new DOMRect(600 - size / 2, 338 - size / 2, size, size))
    const computed = getComputedStyle(element)
    const read = computed.getPropertyValue.bind(computed)
    vi.spyOn(computed, "getPropertyValue").mockImplementation(name => name.startsWith("--safe-") ? name === "--safe-left" || name === "--safe-top" ? "100px" : "20px" : read(name))
    vi.stubGlobal("getComputedStyle", () => computed)
    mark.setPointerCapture = () => {}
    mark.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 600, clientY: 338, pointerId: 1 }))
    mark.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, pointerId: 1 }))
    mark.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1 }))
    expect(JSON.parse(localStorage.getItem("vitehub-tools-dock")!)).toEqual({ edge, at: expected })
  })

  it("docks to the edge where the mark is dragged, keeps a short press a click, and remembers the dock", async () => {
    page("/?vitehub")
    session({ tools: [consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    const mark = element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!
    mark.setPointerCapture = () => {}
    vi.spyOn(mark, "getBoundingClientRect").mockReturnValue(new DOMRect(586, 642, 28, 28))
    const width = 1200
    const height = 676
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(width)
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(height)
    const press = (x: number, y: number, to: Array<[number, number]>) => {
      mark.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: x, clientY: y, pointerId: 1, bubbles: true }))
      for (const [clientX, clientY] of to) mark.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY, pointerId: 1, bubbles: true }))
      mark.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1 }))
      mark.click()
    }
    press(width / 2, height - 20, [[width / 2 + 2, height - 20]])
    expect(element.hasAttribute("collapsed")).toBe(true)
    expect(localStorage.getItem("vitehub-tools-dock")).toBeNull()
    press(width / 2, height - 20, [[width / 2, height / 2], [width - 4, height / 2]])
    expect(element.hasAttribute("collapsed")).toBe(true)
    expect(element.hasAttribute("dragging")).toBe(false)
    expect([element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual(["right", "50"])
    expect(JSON.parse(localStorage.getItem("vitehub-tools-dock")!)).toEqual({ edge: "right", at: 50 })
    await new Promise(resolve => setTimeout(resolve, 0))
    mark.click()
    expect(element.hasAttribute("collapsed")).toBe(false)
  })

  it("moves the off mark where it is dragged, keeps the tools off, and opens the pill there", async () => {
    page("/")
    localStorage.setItem("vitehub-tools-off", "1")
    session({ tools: [consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element, button } = offMark()
    button.setPointerCapture = () => {}
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(592, 660, 16, 14))
    const width = 1200
    const height = 676
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(width)
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(height)
    button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 600, clientY: 667, pointerId: 1 }))
    for (const [clientX, clientY] of [[600, 338], [width - 4, height / 2]]) button.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY, pointerId: 1 }))
    button.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1 }))
    button.click()
    expect(element.isConnected).toBe(true)
    expect(element.hasAttribute("dragging")).toBe(false)
    expect([element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual(["right", "50"])
    expect(JSON.parse(localStorage.getItem("vitehub-tools-dock")!)).toEqual({ edge: "right", at: 50 })
    await new Promise(resolve => setTimeout(resolve, 0))
    button.click()
    await vi.waitFor(() => expect(document.querySelector("vitehub-pill")).not.toBeNull())
    expect(pill().element.getAttribute("edge")).toBe("right")
  })

  it.each([false, true])("keeps a drag bound to its starting pointer (tools off: %s)", async (off) => {
    page("/")
    if (!off) localStorage.setItem("vitehub-tools-collapsed", "1")
    if (off) localStorage.setItem("vitehub-tools-off", "1")
    session({ tools: [consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const element = off ? offMark().element : pill().element
    const button = element.shadowRoot!.querySelector<HTMLButtonElement>(off ? "button" : "button.mark")!
    const capture = vi.fn()
    button.setPointerCapture = capture
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(592, 660, 16, 14))
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1200)
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(676)

    button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 600, clientY: 667, pointerId: 1 }))
    button.dispatchEvent(new PointerEvent("pointermove", { clientX: 1196, clientY: 338, pointerId: 1 }))
    button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 600, clientY: 667, pointerId: 2 }))
    button.dispatchEvent(new PointerEvent("pointermove", { clientX: 4, clientY: 100, pointerId: 2 }))
    expect([element.getAttribute("edge"), element.style.getPropertyValue("--at")]).toEqual(["right", "50"])
    button.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 2 }))
    expect(element.hasAttribute("dragging")).toBe(true)
    expect(localStorage.getItem("vitehub-tools-dock")).toBeNull()
    button.click()
    expect(element.isConnected).toBe(true)
    expect(element.hasAttribute("collapsed")).toBe(true)

    button.dispatchEvent(new PointerEvent("pointermove", { clientX: 1196, clientY: 338, pointerId: 1 }))
    button.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1 }))
    button.click()
    expect(element.isConnected).toBe(true)
    expect(element.hasAttribute("collapsed")).toBe(true)
    expect(element.hasAttribute("dragging")).toBe(false)
    expect(JSON.parse(localStorage.getItem("vitehub-tools-dock")!)).toEqual({ edge: "right", at: 50 })
    expect(capture).toHaveBeenCalledExactlyOnceWith(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    button.click()
    await vi.waitFor(() => expect(pill().element.hasAttribute("collapsed")).toBe(false))
    expect(pill().element.getAttribute("edge")).toBe("right")
  })

  it.each([
    [600, 20, "top"], [600, 656, "bottom"], [1190, 338, "right"], [10, 338, "left"], [40, 40, "top"], [40, 660, "bottom"],
  ] as const)("picks the closest edge for a point (%d, %d)", (x, y, edge) => {
    expect(viteHubPageToolsEdgeAt(x, y, 1200, 676)).toBe(edge)
  })

  it("keeps the pill and its editor connected while a router replaces <body>", async () => {
    page("/?vitehub")
    session({ tools: [{ ...consoleTool, lazy: true }] })
    await loadViteHubPageTools({ load: async () => ({ default(context: ViteHubPageToolContext) {
      const trigger = document.createElement("button")
      context.bar.attachShadow({ mode: "open" }).append(trigger)
      context.createWindow({ id: "console", title: "Console", trigger }).show()
    } }) })
    lazyControl().click()
    await vi.waitFor(() => expect(document.querySelector("vitehub-window")).not.toBeNull())
    const { element } = pill()
    const host = document.querySelector("vitehub-window")!
    const editor = document.createElement("iframe")
    editor.srcdoc = "<textarea></textarea>"
    host.shadowRoot!.querySelector(".body")!.append(editor)
    const browsingContext = editor.contentWindow
    const draft = editor.contentDocument!.querySelector("textarea")!
    draft.value = "Unsaved editor draft"
    const before = document.body
    try {
      before.replaceWith(document.createElement("body"))
      // An observer that restores detached hosts is too late: disconnecting reloads iframe editors.
      expect(editor.isConnected).toBe(true)
      expect(element.isConnected).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(editor.contentWindow).toBe(browsingContext)
      expect(editor.contentDocument!.querySelector("textarea")).toBe(draft)
      expect(draft.value).toBe("Unsaved editor draft")
      expect(element.style.viewTransitionName).toBe("vitehub-pill")
    }
    finally { document.body.replaceWith(before) }
    expect(editor.isConnected).toBe(true)
    pill().exit.click()
    await exited()
    expect(document.querySelector("vitehub-pill")).toBeNull()
  })

  it.each([
    [false, "minimize"],
    [false, "Escape"],
    [true, "minimize"],
    [true, "Escape"],
  ] as const)("returns focus to the mark when a collapsed window hides (restored: %s, action: %s)", async (restored, action) => {
    page(restored ? "/?vitehub" : "/?vitehub=console")
    session({ tools: [{ ...consoleTool, lazy: true }] })
    if (restored) {
      localStorage.setItem("vitehub-tools-collapsed", "1")
      sessionStorage.setItem("vitehub-open:/_vitehub/page/session:console", "true")
    }
    const onHide = vi.fn()
    const load = async () => ({ default(context: ViteHubPageToolContext) {
      const trigger = document.createElement("button")
      context.bar.attachShadow({ mode: "open" }).append(trigger)
      const window = context.createWindow({ id: "console", title: "Console", trigger, onHide })
      if (context.open) window.show()
    } })
    await loadViteHubPageTools({ load })
    const { element } = pill()
    const mark = element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!
    const host = document.querySelector<HTMLElement>("vitehub-window")!
    expect(host.hidden).toBe(false)
    if (!restored) mark.click()
    expect(element.hasAttribute("collapsed")).toBe(true)
    const minimize = host.shadowRoot!.querySelector<HTMLButtonElement>("button.hide")!
    minimize.focus()
    if (action === "minimize") minimize.click()
    else minimize.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }))
    expect(host.hidden).toBe(true)
    expect(document.activeElement).toBe(element)
    expect(element.shadowRoot!.activeElement).toBe(mark)
    expect(element.hasAttribute("collapsed")).toBe(true)
    expect(onHide).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem("vitehub-open:/_vitehub/page/session:console")).toBe("false")
    mark.click()
    expect(element.hasAttribute("collapsed")).toBe(false)
    pill().exit.click()
    await exited()
  })

  it("hides the segment of a tool that leaves it empty", async () => {
    page("/?vitehub")
    session({ tools: [comments, consoleTool] })
    const { load } = modules({ comments: false, console: true })
    await loadViteHubPageTools({ load })
    expect(pill().segments).toEqual([["vitehub-tool", "comments", true], ["vitehub-tool", "console", false]])
  })

  it("opens the tool that ?vitehub=<id> names", async () => {
    page("/?vitehub=console")
    session({ tools: [comments, consoleTool] })
    const { load, started } = modules()
    await loadViteHubPageTools({ load })
    expect(started.map(context => [context.tool.id, context.open])).toEqual([["comments", false], ["console", true]])
    expect(started[1]!.tool.hotkey).toBe("k")
  })

  it("stops every tool, removes the pill and the query on exit, and keeps the hint cookie", async () => {
    page("/guide?vitehub=comments&tab=2")
    session({ tools: [comments, consoleTool] })
    const { load, started, stopped } = modules()
    await loadViteHubPageTools({ load })
    pill().exit.click()
    await exited()
    expect(stopped).toEqual(["comments", "console"])
    expect(started.every(context => context.signal.aborted)).toBe(true)
    expect(document.querySelector("vitehub-pill")).toBeNull()
    expect(document.cookie).toContain("vitehub-tools=1")
    expect(localStorage.getItem("vitehub-tools-off")).toBe("1")
    expect(location.pathname + location.search).toBe("/guide?tab=2")
  })

  it("leaves a small mark where the pill was, and the mark brings the tools back with their windows", async () => {
    page("/?vitehub=console")
    sessionStorage.setItem("vitehub-open:/_vitehub/page/session:console", "true")
    localStorage.setItem("vitehub-tools-dock", JSON.stringify({ edge: "right", at: 20 }))
    const fetch = session({ tools: [comments, consoleTool] })
    const { load, started } = modules()
    await loadViteHubPageTools({ load })
    pill().exit.click()
    await exited()
    expect(document.querySelector("vitehub-pill")).toBeNull()
    const mark = offMark()
    expect([mark.element.getAttribute("edge"), (mark.element as HTMLElement).style.getPropertyValue("--at")]).toEqual(["right", "20"])
    expect(mark.button.getAttribute("aria-label")).toBe("Turn on ViteHub tools")
    expect(mark.button.textContent).toBe("")

    mark.button.click()
    await vi.waitFor(() => expect(started).toHaveLength(4))
    expect(document.querySelector("vitehub-tools-off")).toBeNull()
    expect(localStorage.getItem("vitehub-tools-off")).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(started.slice(2).map(context => [context.tool.id, context.open])).toEqual([["comments", false], ["console", true]])
    pill()
  })

  it.each([[0, true], [1, false]])("gives the mark the focus only after a key press on exit (click detail %i)", async (detail, focused) => {
    page("/?vitehub")
    session({ tools: [comments] })
    await loadViteHubPageTools({ load: modules().load })
    pill().exit.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }))
    await exited()
    const { element, button } = offMark()
    expect(element.shadowRoot!.activeElement === button).toBe(focused)
  })

  it.each(["pill", "off mark"])("removes the %s with stopViteHubPageTools(), and its page watcher stops", async (shown) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    page("/?vitehub")
    session({ tools: [comments, consoleTool] })
    const { load, stopped } = modules()
    await loadViteHubPageTools({ load })
    if (shown === "off mark") pill().exit.click()
    // The checks that the pill or the off mark start with run first.
    await vi.advanceTimersByTimeAsync(250)
    expect(document.querySelectorAll(shown === "pill" ? "vitehub-pill" : "vitehub-tools-off")).toHaveLength(1)
    const under = vi.spyOn(document, "elementsFromPoint")
    stopViteHubPageTools()
    expect(document.querySelectorAll("vitehub-pill, vitehub-tools-off")).toHaveLength(0)
    expect(stopped).toEqual(["comments", "console"])
    // A change of the page starts no check of the pill's place, so no timer outlives the test window.
    document.body.append(document.createElement("div"))
    await vi.advanceTimersByTimeAsync(250)
    expect(under).not.toHaveBeenCalled()
  })

  it("keeps the mark on the next pages without starting a tool, until the mark or ?vitehub turns them on", async () => {
    page("/guide?comment=3&tab=2")
    const fetch = session({ tools: [{ ...comments, param: "comment" }, consoleTool] })
    const { load, started } = modules()
    await loadViteHubPageTools({ load })
    pill().exit.click()
    await exited()
    expect(location.pathname + location.search).toBe("/guide?tab=2")

    // The next page: the session route still answers, so only people with access get the mark.
    offMark().element.remove()
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(document.querySelector("vitehub-pill")).toBeNull()
    expect(started).toHaveLength(2)
    offMark().button.click()
    await vi.waitFor(() => expect(started).toHaveLength(4))
    pill().exit.click()
    await exited()

    offMark().element.remove()
    page("/?vitehub")
    await expect(loadViteHubPageTools({ load })).resolves.toHaveLength(2)
    expect(localStorage.getItem("vitehub-tools-off")).toBeNull()
    expect(document.querySelector("vitehub-tools-off")).toBeNull()
    pill()
  })

  it("draws no mark once the session route allows no tool", async () => {
    page("/")
    localStorage.setItem("vitehub-tools-off", "1")
    session({ tools: [] })
    await expect(loadViteHubPageTools({ load: modules().load })).resolves.toEqual([])
    expect(document.querySelector("vitehub-tools-off")).toBeNull()
  })

  it.each(["vitehub=comments", "comment=3"])("opens an explicit ?%s link after the tools were turned off", async (search) => {
    page(`/guide?${search}`)
    document.cookie = "vitehub-tools=0; Path=/"
    localStorage.setItem("vitehub-tools-off", "1")
    session({ tools: [{ ...comments, lazy: true, param: "comment" }, { ...consoleTool, lazy: true }] })
    const { load, started } = modules()

    await expect(loadViteHubPageTools({ load })).resolves.toHaveLength(2)
    expect(started.map(context => [context.tool.id, context.open])).toEqual([["comments", true]])
    expect(load.mock.calls).toEqual([["/comments.js"]])
    expect(localStorage.getItem("vitehub-tools-off")).toBeNull()
    expect(document.querySelector("vitehub-tools-off")).toBeNull()
    pill()
  })

  it("starts the other tools when one script fails or has no default export", async () => {
    page("/?vitehub")
    session({ tools: [{ ...comments, script: "/broken.js" }, consoleTool] })
    const { load, started } = modules()
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([{ ...comments, script: "/broken.js" }, consoleTool])
    expect(started.map(context => context.tool.id)).toEqual(["console"])
    expect(pill().segments).toEqual([["vitehub-tool", "comments", false], ["vitehub-tool", "console", false]])
    expect(lazyControl().textContent).toBe("Retry Comments")
    expect(console.error).toHaveBeenCalledOnce()
  })

  it("keeps the pill with a retry button when no tool starts", async () => {
    page("/?vitehub")
    session({ tools: [{ ...comments, script: "/broken.js" }] })
    await expect(loadViteHubPageTools({ load: modules().load })).resolves.toEqual([{ ...comments, script: "/broken.js" }])
    expect(lazyControl().textContent).toBe("Retry Comments")
  })

  it("does not mount or remember a window created after startup exits", async () => {
    page("/?vitehub=comments")
    session({ tools: [comments] })
    const load = async () => ({ default: (context: ViteHubPageToolContext) => {
      context.exit()
      const window = context.createWindow({ id: comments.id, title: comments.label, trigger: context.bar })
      window.show()
    } })

    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    expect(document.querySelector("vitehub-pill")).toBeNull()
    expect(document.querySelector("vitehub-window")).toBeNull()
    expect(sessionStorage.getItem("vitehub-open:/_vitehub/page/session:comments")).toBe("false")
  })

  it("cleans up exactly once when a tool exits during startup", async () => {
    page("/?vitehub=comments")
    session({ tools: [comments, consoleTool] })
    let mounted = false
    let context: ViteHubPageToolContext | undefined
    const cleanup = vi.fn(() => { mounted = false })
    const start = vi.fn((value: ViteHubPageToolContext) => {
      context = value
      mounted = true
      value.exit()
      return cleanup
    })
    const load = async () => ({ default: start })

    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    expect(start).toHaveBeenCalledOnce()
    expect(context?.signal.aborted).toBe(true)
    expect(mounted).toBe(false)
    expect(cleanup).toHaveBeenCalledOnce()
    context?.exit()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(document.querySelector("vitehub-pill")).toBeNull()
  })
})

describe("readViteHubPageSession", () => {
  it("keeps tools with an id and a script", () => {
    expect(readViteHubPageSession({ tools: [comments, { id: "x" }, { script: "/y.js" }, "z", { ...consoleTool, hotkey: 1 }] })).toEqual({
      tools: [comments, { id: "console", label: "Console", icon: "i-lucide-square-terminal", script: "/console.js" }],
    })
    expect(readViteHubPageSession(null)).toEqual({ tools: [] })
  })
})

describe("lazy tools", () => {
  it("isolates launch and retry controls from host button styles and leaves tools a fresh segment", async () => {
    page("/?vitehub")
    session({ tools: [{ ...consoleTool, lazy: true }] })
    const style = document.createElement("style")
    style.textContent = "button { display: none !important }"
    document.body.append(style)
    try {
      const start = vi.fn((context: ViteHubPageToolContext) => {
        context.bar.attachShadow({ mode: "open" }).append(document.createElement("button"))
      })
      const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ default: start })
      await loadViteHubPageTools({ load })
      const control = () => {
        const segment = pill().element.querySelector("vitehub-tool")!
        return (segment.shadowRoot ?? segment).querySelector("button")!
      }
      const launch = control()
      expect(getComputedStyle(launch).display).not.toBe("none")
      expect(launch.getRootNode()).toBeInstanceOf(ShadowRoot)
      launch.click()
      await vi.waitFor(() => expect(launch.textContent).toBe("Retry Console"))
      expect(control()).toBe(launch)
      expect(getComputedStyle(launch).display).not.toBe("none")
      launch.click()
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
      expect(control()).not.toBe(launch)
      expect(load).toHaveBeenCalledTimes(2)
    }
    finally { style.remove(); pill().exit.click() }
    await exited()
  })

  it("loads a lazy tool's script when the pointer reaches its button, and shows the click at once", async () => {
    page("/?vitehub")
    session({ tools: [{ ...consoleTool, lazy: true }] })
    let resolve!: (module: ViteHubPageToolModule) => void
    const load = vi.fn(() => new Promise<ViteHubPageToolModule>((done) => { resolve = done }))
    await loadViteHubPageTools({ load })
    const launch = lazyControl()
    const segment = document.querySelector("vitehub-tool")!
    launch.dispatchEvent(new PointerEvent("pointerenter"))
    launch.dispatchEvent(new FocusEvent("focus"))
    expect(load).toHaveBeenCalledOnce()
    launch.click()
    expect(segment.getAttribute("aria-busy")).toBe("true")
    expect(load).toHaveBeenCalledOnce()
    resolve({ default: context => void context.bar.attachShadow({ mode: "open" }).append(document.createElement("button")) })
    await vi.waitFor(() => expect(document.querySelector("vitehub-tool")!.hasAttribute("aria-busy")).toBe(false))
    expect(load).toHaveBeenCalledOnce()
    pill().exit.click()
    await exited()
  })

  it("loads a lazy script again on the next intent after a failed preload", async () => {
    page("/?vitehub")
    session({ tools: [{ ...consoleTool, lazy: true }] })
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ default() {} })
    await loadViteHubPageTools({ load })
    lazyControl().dispatchEvent(new PointerEvent("pointerenter"))
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    await Promise.resolve()
    lazyControl().dispatchEvent(new PointerEvent("pointerenter"))
    expect(load).toHaveBeenCalledTimes(2)
    pill().exit.click()
    await exited()
  })

  it.each([false, true])("rolls back failed startup registrations (lazy: %s)", async (lazy) => {
    page("/?vitehub=console")
    session({ tools: [{ ...consoleTool, lazy }] })
    const signals: AbortSignal[] = []
    const load = vi.fn(async () => ({ default(context: ViteHubPageToolContext) {
      signals.push(context.signal)
      const shadow = context.bar.attachShadow({ mode: "open" })
      const trigger = document.createElement("button")
      shadow.append(trigger)
      const window = context.createWindow({ id: "console", title: "Console", trigger })
      window.show()
      context.onOpen(() => window.show())
      if (signals.length === 1) {
        context.beforeExit(() => false)
        throw new Error("startup failed after opening")
      }
    } }))
    await loadViteHubPageTools({ load })
    expect(document.querySelector("vitehub-window")).toBeNull()
    expect(signals[0]!.aborted).toBe(true)
    // Eager and lazy tools both keep a retry button, so a failure during page load does not need a reload.
    expect(lazyControl().textContent).toBe("Retry Console")
    lazyControl().click()
    await vi.waitFor(() => expect(document.querySelectorAll("vitehub-window")).toHaveLength(1))
    expect(signals[1]!.aborted).toBe(false)
    pill().exit.click()
    await exited()
    expect(signals[1]!.aborted).toBe(true)
    expect(document.querySelector("vitehub-window")).toBeNull()
    expect(document.querySelector("vitehub-pill")).toBeNull()
  })

  it("forgets a destroyed window without hiding it when another tool opens", async () => {
    page("/?vitehub")
    session({ tools: [consoleTool, comments] })
    const { load, started } = modules()
    await loadViteHubPageTools({ load })
    const onHide = vi.fn()
    const first = started[0]!.createWindow({ id: "console", title: "Console", trigger: started[0]!.bar, onHide })
    const second = started[1]!.createWindow({ id: "comments", title: "Comments", trigger: started[1]!.bar })
    first.show()
    first.destroy()
    expect(sessionStorage.getItem("vitehub-open:/_vitehub/page/session:console")).toBe("false")
    expect(document.querySelectorAll("vitehub-window")).toHaveLength(1)
    second.show()
    expect(onHide).not.toHaveBeenCalled()
    pill().exit.click()
    await exited()
  })

  it("keeps a replacement window registered when the previous handle is destroyed", async () => {
    page("/?vitehub")
    session({ tools: [consoleTool, comments] })
    const { load, started } = modules()
    await loadViteHubPageTools({ load })
    const context = started[0]!
    const first = context.createWindow({ id: "console", title: "Console", trigger: context.bar })
    const onHide = vi.fn()
    const replacement = context.createWindow({ id: "console", title: "Console", trigger: context.bar, onHide })
    replacement.show()
    first.destroy()
    expect(sessionStorage.getItem("vitehub-open:/_vitehub/page/session:console")).toBe("true")
    const other = started[1]!.createWindow({ id: "comments", title: "Comments", trigger: started[1]!.bar })
    other.show()
    expect(onHide).toHaveBeenCalledOnce()
    pill().exit.click()
    await exited()
  })

  it("restores a remembered eager window", async () => {
    page("/?vitehub")
    session({ tools: [consoleTool] })
    sessionStorage.setItem("vitehub-open:/_vitehub/page/session:console", "true")
    const load = vi.fn(async () => ({ default(context: ViteHubPageToolContext) {
      const trigger = document.createElement("button")
      context.bar.append(trigger)
      const window = context.createWindow({ id: context.tool.id, title: context.tool.label, trigger })
      if (context.open) window.show()
    } }))

    await loadViteHubPageTools({ load })
    expect(document.querySelector<HTMLElement>("vitehub-window")!.hidden).toBe(false)
    pill().exit.click()
    await exited()
  })

  it.each([false, true])("keeps the query-selected window visible when a restored import finishes later (lazy: %s)", async (lazy) => {
    page("/?vitehub=console")
    session({ tools: [{ ...consoleTool, lazy: true }, { ...comments, lazy }] })
    sessionStorage.setItem("vitehub-open:/_vitehub/page/session:comments", "true")
    const started: string[] = []
    const tool: ViteHubPageToolModule = { default(context) {
      const trigger = document.createElement("button")
      context.bar.append(trigger)
      const window = context.createWindow({ id: context.tool.id, title: context.tool.label, trigger })
      if (context.open) window.show()
      context.onOpen(() => window.show())
      started.push(context.tool.id)
    } }
    let finishRestored!: (value: ViteHubPageToolModule) => void
    const restored = new Promise<ViteHubPageToolModule>(resolve => { finishRestored = resolve })
    const load = vi.fn(async (script: string) => script === comments.script ? restored : tool)
    const loading = loadViteHubPageTools({ load })
    await vi.waitFor(() => expect(started).toEqual(["console"]))
    const selected = document.querySelector<HTMLElement>("vitehub-window")!
    expect(selected.hidden).toBe(false)
    finishRestored(tool)
    await loading
    expect(started).toEqual(["console", "comments"])
    expect(selected.hidden).toBe(false)
    expect([...document.querySelectorAll<HTMLElement>("vitehub-window")].map(window => window.hidden)).toEqual([false, true])
    pill().exit.click()
    await exited()
  })

  it.each(["query", "restored"])("keeps a retry control after a failed %s import", async (activation) => {
    page(activation === "query" ? "/?vitehub=console" : "/?vitehub")
    const lazyTool = { ...consoleTool, lazy: true }
    session({ tools: [lazyTool] })
    if (activation === "restored") sessionStorage.setItem("vitehub-open:/_vitehub/page/session:console", "true")
    const { load: modulesLoad, started } = modules()
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(modulesLoad)
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([lazyTool])
    const retry = lazyControl()
    expect(retry.textContent).toBe("Retry Console")
    expect(retry.isConnected).toBe(true)
    retry.click()
    await vi.waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]!.open).toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
    pill().exit.click()
    await exited()
  })

  it("imports a tool on demand only once", async () => {
    page("/?vitehub")
    session({ tools: [{ ...consoleTool, lazy: true }] })
    const { load, started } = modules()
    await loadViteHubPageTools({ load })
    expect(load).not.toHaveBeenCalled()
    const launch = lazyControl()
    launch.click()
    launch.click()
    await vi.waitFor(() => expect(started).toHaveLength(1))
    expect(load).toHaveBeenCalledTimes(1)
    expect(started[0]!.open).toBe(true)
  })
})

// A failed network import must not strand the only entry into the editor.
it("retries a lazy import and honors the editor exit guard", async () => {
  page("/?vitehub")
  session({ tools: [{ ...consoleTool, lazy: true }] })
  let allowExit = false
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
    default(context: ViteHubPageToolContext) {
      context.bar.append(document.createElement("button"))
      context.beforeExit(() => allowExit)
    },
  })
  await loadViteHubPageTools({ load })
  const launch = lazyControl()
  launch.click()
  await vi.waitFor(() => expect(launch.textContent).toBe("Retry Console"))
  launch.click()
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  pill().exit.click()
  await exited()
  expect(document.querySelector("vitehub-pill")).not.toBeNull()
  allowExit = true
  pill().exit.click()
  await exited()
  expect(document.querySelector("vitehub-pill")).toBeNull()
})

describe("the account item", () => {
  const ada = { name: "Ada Lovelace", email: "ada@example.com", via: "console", signOut: "/api/auth/sign-out" }

  function account() {
    const host = document.querySelector("vitehub-pill vitehub-account")!
    const shadow = host.shadowRoot!
    return {
      host,
      shadow,
      button: shadow.querySelector<HTMLButtonElement>("button.who")!,
      menu: shadow.querySelector<HTMLElement>("[role=menu]")!,
      items: () => [...shadow.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].filter(item => !item.hidden).map(item => item.textContent),
    }
  }

  it("draws no account item without a signed-in person", async () => {
    page("/?vitehub")
    session({ tools: [comments] })
    await loadViteHubPageTools({ load: modules().load })
    expect(pill().slots).toEqual(["tab", "comments"])
    expect(document.querySelector("vitehub-account")).toBeNull()
  })

  it("shows the initials after the tools, as a menu button with the person's name, email, and how they signed in", async () => {
    page("/?vitehub")
    session({ tools: [comments, consoleTool], account: ada })
    await loadViteHubPageTools({ load: modules().load })
    expect(pill().slots).toEqual(["tab", "comments", "console", "vitehub-account"])
    const { button, menu, items } = account()
    expect(button.textContent).toBe("AL")
    expect(button.getAttribute("aria-label")).toBe("Account: Ada Lovelace")
    expect([button.getAttribute("aria-haspopup"), button.getAttribute("aria-expanded"), button.getAttribute("aria-controls")]).toEqual(["menu", "false", menu.id])
    expect(menu.querySelector(".me")?.textContent).toBe("ALAda Lovelaceada@example.com")
    expect(menu.querySelector(".via")?.textContent).toBe("Signed in with ViteHub Console")
    expect(items()).toEqual(["Open in the Console", `Sign out of ${location.host}`])
  })

  it("opens with the focus on the first item, and Escape closes it and gives the focus back", async () => {
    page("/?vitehub")
    session({ tools: [consoleTool], account: ada })
    await loadViteHubPageTools({ load: modules().load })
    const { button, menu, shadow } = account()
    button.click()
    await new Promise(resolve => setTimeout(resolve))
    expect(menu.hidden).toBe(false)
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(shadow.activeElement?.textContent).toBe("Open in the Console")
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(shadow.activeElement?.textContent).toBe(`Sign out of ${location.host}`)
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await new Promise(resolve => setTimeout(resolve))
    expect(menu.hidden).toBe(true)
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(shadow.activeElement).toBe(button)
  })

  it("leaves out the Console item and the line for a guest", async () => {
    page("/?vitehub")
    session({ tools: [comments], account: { name: "Ana", signOut: "/api/auth/sign-out" } })
    await loadViteHubPageTools({ load: modules().load })
    const { menu, items } = account()
    account().button.click()
    await new Promise(resolve => setTimeout(resolve))
    expect(menu.querySelector(".via")).toBeNull()
    expect(items()).toEqual([`Sign out of ${location.host}`])
  })

  it("signs out of the app with Auth's sign-out route, then reloads the page without the tools query", async () => {
    page("/guide?vitehub&tab=2")
    const fetch = session({ tools: [comments], account: { ...ada, signOut: "/portal/api/auth/sign-out" } })
    await loadViteHubPageTools({ load: modules().load })
    const replace = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, href: location.href, host: location.host, replace, reload: vi.fn() })
    fetch.mockImplementation(async () => new Response("{}", { status: 200 }))
    const item = [...account().shadow.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].at(-1)!
    item.click()
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenLastCalledWith("/portal/api/auth/sign-out", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" })
    expect(String(replace.mock.calls[0]![0])).toBe("http://localhost:3000/guide?tab=2")
  })

  it("keeps the session and says so when the sign-out fails", async () => {
    page("/?vitehub")
    const fetch = session({ tools: [comments], account: ada })
    await loadViteHubPageTools({ load: modules().load })
    fetch.mockImplementation(async () => new Response("{}", { status: 403 }))
    const item = [...account().shadow.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].at(-1)!
    item.click()
    await vi.waitFor(() => expect(item.textContent).toBe("Could not sign out. Try again"))
    expect(item.hasAttribute("aria-disabled")).toBe(false)
  })
})
