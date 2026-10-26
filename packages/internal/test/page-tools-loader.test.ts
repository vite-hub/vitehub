import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { loadViteHubPageTools, readViteHubPageSession } from "../src/runtime/page-tools-loader.ts"

import type { ViteHubPageToolContext } from "../src/runtime/page-tools-loader.ts"

const comments = { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/comments.js" }
const pill = { id: "console", label: "Console", icon: "i-lucide-terminal", hotkey: "k", script: "/console.js" }

/** A browser page at `url`: its location, history, and cookie jar. */
function page(url: string) {
  const state = { url: new URL(url), cookie: "vitehub-tools=1" }
  vi.stubGlobal("location", { get search() { return state.url.search }, get href() { return state.url.href } })
  vi.stubGlobal("history", { state: null, replaceState: (_state: unknown, _title: string, next: URL) => { state.url = new URL(next) } })
  vi.stubGlobal("document", { set cookie(value: string) { state.cookie = value } })
  return state
}

function session(value: unknown, status = 200) {
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) => Response.json(value, { status }))
  vi.stubGlobal("fetch", fetch)
  return fetch
}

/** Tool modules by script URL. Each records the context that it got. */
function modules() {
  const started: ViteHubPageToolContext[] = []
  const stopped: string[] = []
  const tool = (id: string) => ({ default: (context: ViteHubPageToolContext) => {
    started.push(context)
    return () => stopped.push(id)
  } })
  const scripts: Record<string, unknown> = { "/comments.js": tool("comments"), "/console.js": tool("console") }
  const load = vi.fn(async (script: string) => scripts[script])
  return { load, started, stopped }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("loadViteHubPageTools", () => {
  it("asks the session route, then imports and starts only the allowed tools", async () => {
    page("https://site.test/pricing?vitehub")
    const fetch = session({ tools: [comments] })
    const { load, started } = modules()
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([comments])
    expect(fetch).toHaveBeenCalledWith("/_vitehub/page/session", { credentials: "same-origin", headers: { accept: "application/json" } })
    expect(load.mock.calls).toEqual([["/comments.js"]])
    expect(started.map(context => [context.tool.id, context.open, context.signal.aborted])).toEqual([["comments", false, false]])
  })

  it("does nothing more when no tool is allowed, or when the session fails", async () => {
    page("https://site.test/")
    const { load } = modules()
    session({ tools: [] })
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    session({ error: { code: "VITEHUB_PAGE_TOOLS_CROSS_ORIGIN" } }, 403)
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    vi.stubGlobal("fetch", async () => { throw new TypeError("offline") })
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([])
    expect(load).not.toHaveBeenCalled()
  })

  it("opens the tool that ?vitehub=<id> names", async () => {
    page("https://site.test/?vitehub=console")
    session({ tools: [comments, pill] })
    const { load, started } = modules()
    await loadViteHubPageTools({ load })
    expect(started.map(context => [context.tool.id, context.open])).toEqual([["comments", false], ["console", true]])
    expect(started[1]!.tool.hotkey).toBe("k")
  })

  it("stops every tool on exit, and clears the hint cookie and the query", async () => {
    const state = page("https://site.test/guide?vitehub=comments&tab=2")
    session({ tools: [comments, pill] })
    const { load, started, stopped } = modules()
    await loadViteHubPageTools({ load })
    started[0]!.exit()
    expect(stopped).toEqual(["comments", "console"])
    expect(started.every(context => context.signal.aborted)).toBe(true)
    expect(state.cookie).toBe("vitehub-tools=; Path=/; Max-Age=0; SameSite=Lax")
    expect(state.url.href).toBe("https://site.test/guide?tab=2")
  })

  it("starts the other tools when one script fails or has no default export", async () => {
    page("https://site.test/?vitehub")
    session({ tools: [{ ...comments, script: "/broken.js" }, pill] })
    const { load, started } = modules()
    await expect(loadViteHubPageTools({ load })).resolves.toEqual([pill])
    expect(started.map(context => context.tool.id)).toEqual(["console"])
    expect(console.error).toHaveBeenCalledOnce()
  })
})

describe("readViteHubPageSession", () => {
  it("keeps tools with an id and a script", () => {
    expect(readViteHubPageSession({ tools: [comments, { id: "x" }, { script: "/y.js" }, "z", { ...pill, hotkey: 1 }] })).toEqual({
      tools: [comments, { id: "console", label: "Console", icon: "i-lucide-terminal", script: "/console.js" }],
    })
    expect(readViteHubPageSession(null)).toEqual({ tools: [] })
  })
})
