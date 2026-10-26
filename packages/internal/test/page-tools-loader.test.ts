// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { loadViteHubPageTools } from "../src/runtime/page-tools-loader.ts"
import { readViteHubPageSession, viteHubPageSessionUrl } from "../src/runtime/page-tools-shared.ts"

import type { ViteHubPageToolContext } from "../src/runtime/page-tools-loader.ts"

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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  for (const element of document.querySelectorAll("vitehub-pill")) element.remove()
  document.cookie = "vitehub-tools=; Path=/; Max-Age=0"
  document.documentElement.className = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("loadViteHubPageTools", () => {
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
    expect(viteHubPageSessionUrl("http://site.test/portal/_vitehub/page/assets/loader.js?v=3")).toBe("/portal/_vitehub/page/session")
    expect(viteHubPageSessionUrl("http://site.test/_vitehub/page/assets/loader.js?v=3")).toBe("/_vitehub/page/session")
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

  it("hides the segment of a tool that leaves it empty", async () => {
    page("/?vitehub")
    session({ tools: [comments, consoleTool] })
    const { load } = modules({ comments: false, console: true })
    await loadViteHubPageTools({ load })
    expect(pill().segments).toEqual([["vitehub-tool", "comments", true], ["vitehub-tool", "console", false]])
  })

  it("follows the page's dark scheme", async () => {
    page("/?vitehub")
    session({ tools: [consoleTool] })
    await loadViteHubPageTools({ load: modules().load })
    const { element } = pill()
    expect(element.style.colorScheme).toBe("light")
    document.documentElement.classList.add("dark")
    await new Promise(resolve => setTimeout(resolve))
    expect(element.style.colorScheme).toBe("dark")
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
})

describe("readViteHubPageSession", () => {
  it("keeps tools with an id and a script", () => {
    expect(readViteHubPageSession({ tools: [comments, { id: "x" }, { script: "/y.js" }, "z", { ...consoleTool, hotkey: 1 }] })).toEqual({
      tools: [comments, { id: "console", label: "Console", icon: "i-lucide-square-terminal", script: "/console.js" }],
    })
    expect(readViteHubPageSession(null)).toEqual({ tools: [] })
  })
})
