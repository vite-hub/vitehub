// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { loadViteHubPageTools } from "../src/runtime/page-tools-loader.ts"
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

function lazyControl(): HTMLButtonElement {
  return document.querySelector("vitehub-tool")!.shadowRoot!.querySelector<HTMLButtonElement>("button")!
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  for (const element of document.querySelectorAll("vitehub-pill, vitehub-window")) element.remove()
  document.cookie = "vitehub-tools=; Path=/; Max-Age=0"
  document.documentElement.className = ""
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
    expect(slots).toEqual(["console"])
    expect(exit.querySelector("svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg")
    exit.click()
    expect(stopped).toEqual(["console"])
    expect(document.querySelector("vitehub-pill")).toBeNull()
  })

  it("asks the session route, then imports and starts only the allowed tools", async () => {
    page("/pricing?vitehub")
    const fetch = session({ tools: [comments] })
    const { load, started } = modules()
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([comments])
    expect(fetch).toHaveBeenCalledWith("/_vitehub/page/session", { credentials: "same-origin", headers: { accept: "application/json" } })
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
    expect(fetch).toHaveBeenCalledWith("/portal/_vitehub/page/session", { credentials: "same-origin", headers: { accept: "application/json" } })
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
    expect(element.parentElement).toBe(document.body)
    expect(slots).toEqual(["comments", "console"])
    expect(segments).toEqual([["vitehub-tool", "comments", false], ["vitehub-tool", "console", false]])
    expect(started.map(context => context.bar)).toEqual([...element.children])
    expect(element.shadowRoot!.querySelector("[role=toolbar]")!.getAttribute("aria-label")).toBe("ViteHub tools")
    expect(exit.title).toBe("Turn off ViteHub tools")
    // A second loader on the same page leaves the pill alone.
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    pill()
  })

  it("collapses to the ViteHub mark, keeps the tools running, and remembers it on the next page", async () => {
    page("/?vitehub")
    session({ tools: [comments, consoleTool] })
    const first = modules()
    await loadViteHubPageTools({ load: first.load })
    const { element } = pill()
    const mark = element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!
    expect([mark.getAttribute("aria-expanded"), mark.getAttribute("aria-label")]).toEqual(["true", "Hide ViteHub tools"])
    mark.click()
    expect(element.hasAttribute("collapsed")).toBe(true)
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

  it("stops every tool, removes the pill, and clears the hint cookie and the query on exit", async () => {
    page("/guide?vitehub=comments&tab=2")
    session({ tools: [comments, consoleTool] })
    const { load, started, stopped } = modules()
    await loadViteHubPageTools({ load })
    pill().exit.click()
    expect(stopped).toEqual(["comments", "console"])
    expect(started.every(context => context.signal.aborted)).toBe(true)
    expect(document.querySelector("vitehub-pill")).toBeNull()
    expect(document.cookie).not.toContain("vitehub-tools=1")
    expect(location.pathname + location.search).toBe("/guide?tab=2")
  })

  it("starts the other tools when one script fails or has no default export", async () => {
    page("/?vitehub")
    session({ tools: [{ ...comments, script: "/broken.js" }, consoleTool] })
    const { load, started } = modules()
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([consoleTool])
    expect(started.map(context => context.tool.id)).toEqual(["console"])
    expect(pill().segments).toEqual([["vitehub-tool", "console", false]])
    expect(console.error).toHaveBeenCalledOnce()
  })

  it("removes the pill when no tool starts", async () => {
    page("/?vitehub")
    session({ tools: [{ ...comments, script: "/broken.js" }] })
    await expect(loadViteHubPageTools({ load: modules().load })).resolves.toEqual([])
    expect(document.querySelector("vitehub-pill")).toBeNull()
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
    if (!lazy) {
      expect(document.querySelector("vitehub-pill")).toBeNull()
      return
    }
    lazyControl().click()
    await vi.waitFor(() => expect(document.querySelectorAll("vitehub-window")).toHaveLength(1))
    expect(signals[1]!.aborted).toBe(false)
    pill().exit.click()
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
  expect(document.querySelector("vitehub-pill")).not.toBeNull()
  allowExit = true
  pill().exit.click()
  expect(document.querySelector("vitehub-pill")).toBeNull()
})
