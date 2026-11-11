import { hostedConsoleUrl } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"

import { consoleOpenPage, parseConsoleOpenQuery } from "../src/console/runtime/client/open-link.ts"
import { consoleProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { browserProjectStorage, createConsoleProjectStore, memoryProjectStorage } from "../src/console/runtime/client/projects.ts"
import { operationRpcFetch } from "../../internal/test-utils/operation-rpc.ts"

const pageProject = consoleProject()
afterEach(() => {
  setConsoleProject(pageProject)
  vi.unstubAllGlobals()
  vi.resetModules()
})

const projectGet = { ok: true, value: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv"], operations: ["kv.list"] } }
const shop = { origin: "https://shop.example.com", base: "", url: "https://shop.example.com" }

function page(pathname: string, search: string) {
  const replaceState = vi.fn<(data: unknown, unused: string, url: string) => void>()
  return { location: { pathname, search }, history: { state: { key: 1 }, replaceState }, replaceState }
}

describe("/open query", () => {
  it("reads the project and the Console path that hostedConsoleUrl() writes", () => {
    const url = new URL(hostedConsoleUrl("https://shop.example.com/portal", "/agents/bot/invocations/abc?tab=trace"))
    expect(url.pathname).toBe("/open")
    expect(parseConsoleOpenQuery(url.search)).toEqual({
      kind: "open",
      target: { origin: "https://shop.example.com", base: "/portal", url: "https://shop.example.com/portal" },
      path: "/agents/bot/invocations/abc?tab=trace",
    })
  })

  it("reads a link that a person typed without encoding, and opens the Overview without a path", () => {
    expect(parseConsoleOpenQuery("?project=https://shop.example.com&path=/kv")).toEqual({ kind: "open", target: shop, path: "/kv" })
    expect(parseConsoleOpenQuery("?project=https://shop.example.com/_vitehub/kv")).toEqual({ kind: "open", target: shop, path: "/" })
    expect(parseConsoleOpenQuery("?project=http://127.0.0.1:4872&path=/_vitehub/kv")).toMatchObject({ kind: "open", path: "/kv" })
  })

  it("refuses projects that are not https, or http on a loopback host", () => {
    expect(parseConsoleOpenQuery("")).toMatchObject({ kind: "problem", problem: { title: "This link names no project" } })
    for (const project of ["http://shop.example.com", "javascript:alert(1)", "shop.example.com", "https://user:pass@shop.example.com"]) {
      expect(parseConsoleOpenQuery(`?${new URLSearchParams({ project, path: "/kv" })}`), project).toMatchObject({ kind: "problem", problem: { title: "Check the project URL" } })
    }
  })

  it("refuses paths that leave the Console", () => {
    for (const path of ["https://evil.example.com", "//evil.example.com", "/\\evil.example.com", "/\t/evil.example.com", "/.//evil.example.com", "kv", "javascript:alert(1)"]) {
      expect(parseConsoleOpenQuery(`?${new URLSearchParams({ project: shop.url, path })}`), path).toMatchObject({ kind: "problem", problem: { title: "Check the Console path" } })
    }
  })

  it("puts the path below the Console base", () => {
    expect(consoleOpenPage("/", "/kv")).toBe("/kv")
    expect(consoleOpenPage("/console/", "/kv?key=a")).toBe("/console/kv?key=a")
  })
})

describe("opening an /open link", () => {
  async function boot(storage = memoryProjectStorage(), fetch: () => Promise<Response> = async () => Response.json(projectGet)) {
    vi.stubGlobal("fetch", operationRpcFetch(vi.fn(fetch)))
    const session = await import("../src/console/runtime/client/project-session.ts")
    const open = await import("../src/console/runtime/client/open-link.ts")
    const navigate = vi.fn<(url: string) => void>()
    const start = (pathname: string, search: string) => {
      const window = page(pathname, search)
      const request = open.startConsoleOpen(window, "/", storage)
      const state = session.startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate, pageOrigin: "https://console.vitehub.dev", storage })
      if (request) open.continueConsoleOpen(request)
      return { request, state, window }
    }
    return { navigate, open, session, start, storage }
  }

  it("switches to a linked project and opens the path at once", async () => {
    const storage = memoryProjectStorage()
    const store = createConsoleProjectStore(storage)
    const linked = store.save({ url: shop.url, label: "Shop", token: "secret" })
    const other = store.save({ url: "https://blog.example.com" })
    store.select(other.id)
    const { navigate, open, start } = await boot(storage)

    const { request, state, window } = start("/open", `?project=${encodeURIComponent(shop.url)}&path=${encodeURIComponent("/agents/bot")}`)
    expect(request).toBeUndefined()
    expect(window.replaceState).toHaveBeenCalledWith({ key: 1 }, "", "/agents/bot")
    expect(state.current.value).toEqual(linked)
    expect(state.linkOpen.value).toBe(false)
    expect(open.useConsoleOpenRequest().value).toBeUndefined()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("asks to link another project with its URL filled in, then opens the path after the link", async () => {
    const { navigate, open, session, start } = await boot()

    const { state, window } = start("/open", "?project=https://shop.example.com&path=/kv")
    expect(window.replaceState).toHaveBeenCalledWith({ key: 1 }, "", "/")
    expect(state.gate.value).toEqual({ kind: "empty" })
    expect(state.linkOpen.value).toBe(true)
    expect(open.useConsoleOpenRequest().value).toEqual({ target: shop, path: "/kv" })

    const result = await session.linkConsoleProject(shop.url)
    if (result.kind !== "linked") throw new Error(`Expected a linked project, got ${result.kind}`)
    const navigatePage = vi.fn<(path: string) => void>()
    expect(open.finishConsoleOpen(result.project, navigatePage)).toBe(true)
    expect(navigatePage).toHaveBeenCalledWith("/kv")
    expect(navigate).not.toHaveBeenCalled()
    await session.consoleProjectReady()
    expect(state.current.value?.url).toBe(shop.url)
    expect(state.store.active()?.url).toBe(shop.url)
    expect(open.useConsoleOpenRequest().value).toBeUndefined()
  })

  it.each(["blocked", "full"])("keeps the first project and token when storage is %s", async (failure) => {
    const storage = browserProjectStorage(() => {
      if (failure === "blocked") throw new Error("Storage is blocked")
      return {
        getItem: () => null,
        setItem: (key) => {
          if (!key.endsWith(":probe")) throw new Error("Storage is full")
        },
        removeItem: () => {},
      }
    })
    const { navigate, open, session, start } = await boot(storage)
    const { state } = start("/open", `?${new URLSearchParams({ project: shop.url, path: "/kv?key=a#value" })}`)
    const router = createRouter({
      history: createMemoryHistory("/console/"),
      routes: [{ path: "/kv", component: { render: () => null } }],
    })
    router.beforeEach(() => session.consoleProjectReady())

    const result = await session.linkConsoleProject(shop.url, "secret")
    if (result.kind !== "linked") throw new Error(`Expected a linked project, got ${result.kind}`)
    expect(storage.persistent).toBe(false)
    expect(open.finishConsoleOpen(result.project, path => void router.push(path))).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
    await router.isReady()

    expect(router.currentRoute.value.fullPath).toBe("/kv?key=a#value")
    expect(router.resolve(router.currentRoute.value).href).toBe("/console/kv?key=a#value")
    expect(state.current.value).toMatchObject({ url: shop.url, token: "secret" })
    expect(state.gate.value).toEqual({ kind: "ready" })
    const project = await import("../src/console/runtime/client/project.ts")
    const request = await project.projectRequest("/_vitehub/rpc")
    expect(request.url).toBe(`${shop.url}/_vitehub/rpc`)
    expect(request.headers).toEqual({ authorization: "Bearer secret" })
  })

  it("reloads the requested page when another project is already open", async () => {
    const storage = memoryProjectStorage()
    createConsoleProjectStore(storage).save({ url: "https://blog.example.com" })
    const { navigate, open, session, start } = await boot(storage)
    start("/open", "?project=https://shop.example.com&path=/kv")
    await session.openConsoleProject()

    const result = await session.linkConsoleProject(shop.url)
    if (result.kind !== "linked") throw new Error(`Expected a linked project, got ${result.kind}`)
    const navigatePage = vi.fn<(path: string) => void>()
    expect(open.finishConsoleOpen(result.project, navigatePage)).toBe(true)
    expect(navigate).toHaveBeenCalledWith("/kv")
    expect(navigatePage).not.toHaveBeenCalled()
  })

  it("opens the Overview when the person links another URL in the dialog", async () => {
    const { open, session, start } = await boot()
    start("/open", "?project=https://shop.example.com&path=/kv")

    const result = await session.linkConsoleProject("https://blog.example.com")
    if (result.kind !== "linked") throw new Error(`Expected a linked project, got ${result.kind}`)
    expect(open.finishConsoleOpen(result.project, vi.fn())).toBe(false)
    open.cancelConsoleOpen()
    expect(open.useConsoleOpenRequest().value).toBeUndefined()
  })

  it("shows why a link cannot open a project, and never navigates away from the Console", async () => {
    const { navigate, open, start } = await boot()

    const { state, window } = start("/open", `?project=${encodeURIComponent(shop.url)}&path=${encodeURIComponent("//evil.example.com")}`)
    expect(window.replaceState).toHaveBeenCalledWith({ key: 1 }, "", "/")
    expect(state.gate.value).toMatchObject({ kind: "problem", problem: { title: "Check the Console path" } })
    expect(state.linkOpen.value).toBe(false)
    expect(open.useConsoleOpenRequest().value).toBeUndefined()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("does nothing on another page", async () => {
    const { open } = await boot()
    const window = page("/kv", "?project=https://shop.example.com")
    expect(open.startConsoleOpen(window, "/", memoryProjectStorage())).toBeUndefined()
    expect(window.replaceState).not.toHaveBeenCalled()
  })
})
