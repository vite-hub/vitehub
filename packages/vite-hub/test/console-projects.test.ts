import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleProject, projectConsoleUrl, isRemoteProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { consoleProjectProblem, probeConsoleProject } from "../src/console/runtime/client/project-link.ts"
import { consoleProjectHost, consoleProjectsStorageKey, createConsoleProjectStore, isMixedContentProject, memoryProjectStorage, normalizeProjectUrl } from "../src/console/runtime/client/projects.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"

const pageProject = consoleProject()
afterEach(() => {
  setConsoleProject(pageProject)
  vi.unstubAllGlobals()
  vi.resetModules()
})

const target = { origin: "https://app.example.com", base: "/portal" }
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  async () => Response.json(body, { headers, status })
const projectGet = { ok: true, value: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv", "logs"], operations: ["kv.list"] } }
const tokenRejection = { code: "CONSOLE_TOKEN_INVALID", message: "This request has no Console token.", ok: false, status: 401 }

describe("project URLs", () => {
  it.each([
    ["https://app.example.com", "https://app.example.com", ""],
    ["https://app.example.com/", "https://app.example.com", ""],
    ["https://app.example.com/portal/", "https://app.example.com", "/portal"],
    ["app.example.com/portal", "https://app.example.com", "/portal"],
    ["localhost:5173", "http://localhost:5173", ""],
    ["127.0.0.1:4100/", "http://127.0.0.1:4100", ""],
    ["https://app.example.com/portal/_vitehub/kv?store=default#top", "https://app.example.com", "/portal"],
    ["  https://APP.example.com:443/_vitehub  ", "https://app.example.com", ""],
  ])("reads %s as origin and base", (input, origin, base) => {
    expect(normalizeProjectUrl(input)).toEqual({ target: { origin, base, url: `${origin}${base}` } })
  })

  it.each([
    ["", "Enter the URL of the app"],
    ["ftp://app.example.com", "Use an https:// URL"],
    ["https://user:secret@app.example.com", "Remove the user name and password"],
    ["https://exa mple.com", "is not a URL"],
  ])("rejects %j with a fix", (input, message) => {
    const result = normalizeProjectUrl(input)
    expect("error" in result && result.error).toContain(message)
  })

  it("shows the host and mount, and finds mixed content", () => {
    expect(consoleProjectHost({ url: "https://app.example.com/portal" })).toBe("app.example.com/portal")
    expect(isMixedContentProject({ origin: "http://app.example.com", base: "", url: "http://app.example.com" }, "https:")).toBe(true)
    expect(isMixedContentProject({ origin: "http://localhost:5173", base: "", url: "http://localhost:5173" }, "https:")).toBe(false)
    expect(isMixedContentProject({ origin: "http://app.example.com", base: "", url: "http://app.example.com" }, "http:")).toBe(false)
  })
})

describe("project store", () => {
  it("links, updates, selects, and forgets projects in one storage key", () => {
    const storage = memoryProjectStorage()
    const store = createConsoleProjectStore(storage)

    const a = store.save({ url: "https://a.example.com", label: "A", token: "token-a" })
    const b = store.save({ url: "https://b.example.com/portal", token: "token-b" })
    store.select(b.id)
    expect(store.list().map(project => project.url)).toEqual(["https://a.example.com", "https://b.example.com/portal"])
    expect(store.active()?.id).toBe(b.id)

    // The same URL updates the project. `undefined` keeps the token, `null` removes it.
    expect(store.save({ url: "https://a.example.com", label: "Shop" })).toEqual({ id: a.id, url: "https://a.example.com", label: "Shop", token: "token-a" })
    expect(store.save({ url: "https://a.example.com", token: null }).token).toBeUndefined()
    expect(store.list()).toHaveLength(2)

    // A second store on the same storage, such as another tab, reads the same list.
    expect(createConsoleProjectStore(storage).find("https://b.example.com/portal")?.token).toBe("token-b")

    store.forget(b.id)
    expect(store.list().map(project => project.id)).toEqual([a.id])
    expect(store.active()?.id).toBe(a.id)
    store.forget(a.id)
    expect(store.active()).toBeUndefined()
    expect(JSON.parse(storage.getItem(consoleProjectsStorageKey) ?? "")).toEqual({ projects: [] })
  })

  it("drops stored entries that are not projects", () => {
    const storage = memoryProjectStorage()
    storage.setItem(consoleProjectsStorageKey, JSON.stringify({
      active: "gone",
      projects: [
        { id: "a", url: "https://a.example.com/", token: " t " },
        { id: "a", url: "https://other.example.com" },
        { id: "b", url: "javascript:alert(1)" },
        { url: "https://c.example.com" },
        "text",
      ],
    }))
    const store = createConsoleProjectStore(storage)
    expect(store.list()).toEqual([{ id: "a", url: "https://a.example.com", token: "t" }])
    expect(store.active()).toBeUndefined()

    storage.setItem(consoleProjectsStorageKey, "{not json")
    expect(store.list()).toEqual([])
  })
})

describe("project.get probe", () => {
  it("calls project.get without cookies and with the token", async () => {
    const fetch = vi.fn(json(200, projectGet))
    const probe = await probeConsoleProject(target, "secret", { fetch })
    expect(probe).toEqual({ kind: "ready", info: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv", "logs"], operations: ["kv.list"] } })
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe("https://app.example.com/portal/_vitehub/rpc/__call")
    expect(init.credentials).toBe("same-origin")
    expect(init.headers).toEqual({ "authorization": "Bearer secret", "content-type": "application/json", [consoleRpcHeader]: "1" })
    expect(JSON.parse(String(init.body))).toEqual({ operation: "project.get", input: {} })
  })

  it("asks for a token on a 401 of auth: \"token\", also when the challenge header is hidden", async () => {
    expect(await probeConsoleProject(target, undefined, { fetch: json(401, tokenRejection) })).toEqual({ kind: "token", rejected: false })
    expect(await probeConsoleProject(target, "wrong", { fetch: json(401, tokenRejection, { "www-authenticate": 'Bearer realm="vitehub-console", error="invalid_token"' }) })).toEqual({ kind: "token", rejected: true })
  })

  it("tells OAuth and app sign-in apart from the token", async () => {
    const oauth = json(401, { code: "CONSOLE_SIGN_IN_REQUIRED" }, { "www-authenticate": 'Bearer realm="vitehub-console", resource_metadata="https://app.example.com/.well-known/oauth-protected-resource"' })
    expect(await probeConsoleProject(target, undefined, { fetch: oauth })).toEqual({ kind: "oauth" })
    const session = json(401, { code: "CONSOLE_SIGN_IN_REQUIRED" }, { "www-authenticate": 'Bearer realm="vitehub-console"' })
    expect(await probeConsoleProject(target, undefined, { fetch: session })).toEqual({ kind: "sign-in" })
  })

  it("reads a fetch TypeError as unreachable, and names console.origins", async () => {
    const probe = await probeConsoleProject(target, "secret", { fetch: async () => { throw new TypeError("Failed to fetch") } })
    expect(probe).toEqual({ kind: "unreachable" })
    expect(consoleProjectProblem({ kind: "unreachable" }, { consoleOrigin: "https://console.example.com", host: "app.example.com/portal", url: "https://app.example.com/portal" }).message)
      .toBe("https://console.example.com is not in console.origins for app.example.com/portal. Add it and redeploy. The project may also be offline.")
  })

  it("lets an abort through", async () => {
    const abort = new DOMException("Aborted", "AbortError")
    await expect(probeConsoleProject(target, undefined, { fetch: async () => { throw abort } })).rejects.toBe(abort)
  })

  it("blocks another protocol and a vite-hub without project.get", async () => {
    const newer = await probeConsoleProject(target, "secret", { fetch: json(200, { ok: true, value: { protocol: 2, vitehub: "0.4.0" } }) })
    expect(newer).toEqual({ kind: "protocol", protocol: 2, vitehub: "0.4.0" })
    const context = { consoleOrigin: "https://console.example.com", host: "app.example.com", url: "https://app.example.com" }
    if (newer.kind !== "protocol") throw new Error("Expected a protocol probe")
    expect(consoleProjectProblem(newer, context).message).toBe("This project runs vite-hub 0.4.0. This Console needs protocol 1. Update vite-hub.")

    const older = await probeConsoleProject(target, "secret", { fetch: json(404, { code: "CONSOLE_NOT_FOUND", message: "Console operation not found.", ok: false, status: 404 }) })
    expect(older).toEqual({ kind: "protocol" })
    expect(consoleProjectProblem({ kind: "protocol" }, context).message).toBe("This project runs an older vite-hub. This Console needs protocol 1. Update vite-hub.")
  })

  it("names a URL without a Console and a server error with its fix", async () => {
    expect(await probeConsoleProject(target, undefined, { fetch: async () => new Response("Not found", { status: 404 }) })).toEqual({ kind: "missing" })
    const unset = await probeConsoleProject(target, "secret", { fetch: json(500, { code: "CONSOLE_TOKEN_NOT_CONFIGURED", message: "console: { auth: \"token\" } needs VITEHUB_CONSOLE_TOKEN in the server environment, and it is not set.", fix: "Set VITEHUB_CONSOLE_TOKEN.", ok: false, status: 500 }) })
    expect(unset).toEqual({ kind: "failed", status: 500, message: "console: { auth: \"token\" } needs VITEHUB_CONSOLE_TOKEN in the server environment, and it is not set.", fix: "Set VITEHUB_CONSOLE_TOKEN." })
  })
})

describe("linking a project", () => {
  async function session(fetch: (url: string, init: RequestInit) => Promise<Response>, pageOrigin = "https://console.example.com") {
    vi.stubGlobal("fetch", fetch)
    const module = await import("../src/console/runtime/client/project-session.ts")
    const navigate = vi.fn()
    const storage = memoryProjectStorage()
    const state = module.startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate, pageOrigin, storage })
    return { module, navigate, state, storage }
  }

  it("starts empty in hosted mode, asks for the token, then saves and switches", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const authorization = new Headers(init.headers).get("authorization")
      if (authorization === "Bearer right") return Response.json(projectGet)
      return Response.json(tokenRejection, { status: 401 })
    })
    const { module, navigate, state } = await session(fetch)
    expect(state.gate.value).toEqual({ kind: "empty" })

    const first = await module.linkConsoleProject("app.example.com/portal")
    expect(first).toEqual({ kind: "token", rejected: false, target: { origin: "https://app.example.com", base: "/portal", url: "https://app.example.com/portal" } })
    expect(await module.linkConsoleProject("https://app.example.com/portal", "wrong")).toMatchObject({ kind: "token", rejected: true })
    const linked = await module.linkConsoleProject("https://app.example.com/portal", "right")
    expect(linked).toMatchObject({ kind: "linked", project: { url: "https://app.example.com/portal", label: "Shop", token: "right" } })
    expect(state.store.active()?.url).toBe("https://app.example.com/portal")

    if (linked.kind !== "linked") throw new Error("Expected a linked project")
    module.switchConsoleProject(linked.project.id)
    expect(navigate).toHaveBeenCalledWith("/")
  })

  it("explains CORS, mixed content, and a bad URL without saving", async () => {
    const { module, state } = await session(async () => { throw new TypeError("Failed to fetch") })
    expect(await module.linkConsoleProject("https://app.example.com")).toEqual({
      kind: "problem",
      problem: { title: "Cannot reach app.example.com", message: "https://console.example.com is not in console.origins for app.example.com. Add it and redeploy. The project may also be offline." },
    })
    expect(await module.linkConsoleProject("http://app.example.com")).toMatchObject({ kind: "problem", problem: { title: "Use HTTPS" } })
    expect(await module.linkConsoleProject("ftp://app.example.com")).toMatchObject({ kind: "problem", problem: { title: "Check the URL" } })
    expect(state.store.list()).toEqual([])
  })

  it("opens the active project with its token and sends every request there", async () => {
    const fetch = vi.fn(async () => Response.json(projectGet))
    vi.stubGlobal("fetch", fetch)
    const module = await import("../src/console/runtime/client/project-session.ts")
    const storage = memoryProjectStorage()
    const store = createConsoleProjectStore(storage)
    store.select(store.save({ url: "https://b.example.com", token: "token-b" }).id)
    const state = module.startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate: () => {}, pageOrigin: "https://console.example.com", storage })

    await module.openConsoleProject()
    await module.consoleProjectReady()
    expect(state.gate.value).toEqual({ kind: "ready" })
    expect(state.info.value?.name).toBe("Shop")
    expect(state.store.active()?.label).toBe("Shop")
    const { consoleProject: active, projectUrl } = await import("../src/console/runtime/client/project.ts")
    expect(projectUrl("/_vitehub/rpc/__call")).toBe("https://b.example.com/_vitehub/rpc/__call")
    expect(active().authorization?.()).toBe("Bearer token-b")
  })

  it("shows the token form in embedded mode, and stores the token for the page origin", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get("authorization") === "Bearer right" ? Response.json(projectGet) : Response.json(tokenRejection, { status: 401 }))
    vi.stubGlobal("fetch", fetch)
    const module = await import("../src/console/runtime/client/project-session.ts")
    const storage = memoryProjectStorage()
    const state = module.startConsoleProjects({ base: "/portal", home: "/portal/_vitehub/", mode: "embedded", navigate: () => {}, pageOrigin: "https://app.example.com", storage })

    await module.openConsoleProject()
    expect(state.gate.value).toEqual({ kind: "token", rejected: false })
    // The embedded Console calls its own origin, so the request path has no origin.
    expect(fetch.mock.calls[0]![0]).toBe("/portal/_vitehub/rpc/__call")
    expect(await module.signInConsoleProject("wrong")).toEqual({ kind: "token", rejected: true })
    expect(await module.signInConsoleProject("right")).toEqual({ kind: "ready" })
    expect(createConsoleProjectStore(storage).find("https://app.example.com/portal")?.token).toBe("right")
  })

  it("opens an embedded app that needs an app session, so its own pages show sign-in", async () => {
    const { module, state } = await (async () => {
      vi.stubGlobal("fetch", async () => Response.json({ code: "CONSOLE_SIGN_IN_REQUIRED", ok: false, status: 401 }, { status: 401, headers: { "www-authenticate": 'Bearer realm="vitehub-console"' } }))
      const module = await import("../src/console/runtime/client/project-session.ts")
      return { module, state: module.startConsoleProjects({ base: "", home: "/_vitehub/", mode: "embedded", navigate: () => {}, pageOrigin: "https://app.example.com", storage: memoryProjectStorage() }) }
    })()
    await module.openConsoleProject()
    expect(state.gate.value).toEqual({ kind: "ready" })
  })
})

describe("remote project links", () => {
  it("links features that need the app origin to the app's own Console", () => {
    expect(isRemoteProject()).toBe(false)
    expect(projectConsoleUrl("/kv")).toBe("/_vitehub/kv")
    setConsoleProject({ origin: "https://app.example.com", base: "/portal" })
    expect(isRemoteProject()).toBe(true)
    expect(projectConsoleUrl("/auth/users")).toBe("https://app.example.com/portal/_vitehub/auth/users")
  })
})
