import { afterEach, describe, expect, it, vi } from "vitest"

import { envActivitySchema, requestEnvManagement } from "../src/console/runtime/client/env-management.ts"
import { consoleProject, isRemoteProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { consoleProjectProblem, probeConsoleProject } from "../src/console/runtime/client/project-link.ts"
import { browserProjectStorage, consoleProjectHost, consoleProjectsStorageKey, createConsoleProjectStore, isMixedContentProject, memoryProjectStorage, normalizeProjectUrl } from "../src/console/runtime/client/projects.ts"
import type { ConsoleBrowserStorage } from "../src/console/runtime/client/projects.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { operationRpcFetch, operationRpcRequest } from "../../internal/test-utils/operation-rpc.ts"

const pageProject = consoleProject()
afterEach(() => {
  setConsoleProject(pageProject)
  vi.unstubAllGlobals()
  vi.resetModules()
})

const target = { origin: "https://app.example.com", base: "/portal" }
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  operationRpcFetch(async () => Response.json(body, { headers, status }))
const projectGet = { ok: true, value: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv", "logs"], operations: ["kv.list"] } }
const tokenRejection = { code: "CONSOLE_TOKEN_INVALID", message: "This request has no Console token.", ok: false, status: 401 }

function pendingResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

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
    // Only a whole `/_vitehub` segment starts the Console, so these mounts stay.
    ["https://app.example.com/_vitehub-app", "https://app.example.com", "/_vitehub-app"],
    ["https://app.example.com/portal/_vitehub-assets/", "https://app.example.com", "/portal/_vitehub-assets"],
    ["https://app.example.com/_vitehub-app/_vitehub/kv", "https://app.example.com", "/_vitehub-app"],
    ["https://app.example.com/portal/_vitehub-tools/_vitehub/kv", "https://app.example.com", "/portal/_vitehub-tools"],
  ])("reads %s as origin and base", (input, origin, base) => {
    expect(normalizeProjectUrl(input)).toEqual({ target: { origin, base, url: `${origin}${base}` } })
  })

  it.each([
    ["", "Enter the URL of the app"],
    ["ftp://app.example.com", "Use an https:// URL"],
    ["https://user:secret@app.example.com", "Remove the user name and password"],
    ["https://exa mple.com", "is not a URL"],
    // Chrome's URL parser encodes the space in the host instead of throwing, as Node's does.
    ["comark ui", "is not a URL"],
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
  it("saves and selects a project when randomUUID is unavailable on HTTP", () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    const store = createConsoleProjectStore(memoryProjectStorage())
    const project = store.save({ url: "http://app.example.com", token: "token" })
    store.select(project.id)
    expect(project.id).toBeTruthy()
    expect(store.active()).toEqual(project)
    expect(store.save({ url: project.url, label: "Shop" }).id).toBe(project.id)
    expect(store.save({ url: "http://other.example.com" }).id).not.toBe(project.id)
  })

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

/** A `localStorage` that reads, and refuses writes from the `failFrom`th write, like a full or restricted storage. */
function refusingStorage(failFrom = 1): ConsoleBrowserStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  let writes = 0
  return {
    getItem: key => values.get(key) ?? null,
    removeItem: key => void values.delete(key),
    setItem: (key, value) => {
      if (++writes >= failFrom) throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
      values.set(key, value)
    },
    values,
  }
}

describe("browser storage", () => {
  it("keeps localStorage when it accepts writes", () => {
    const local = refusingStorage(Number.POSITIVE_INFINITY)
    const storage = browserProjectStorage(() => local)
    createConsoleProjectStore(storage).save({ url: "https://a.example.com" })
    expect(storage.persistent).toBe(true)
    expect(local.values.has(consoleProjectsStorageKey)).toBe(true)
    expect([...local.values.keys()]).toEqual([consoleProjectsStorageKey])
  })

  it("moves to memory when storage refuses the first write, or blocks access", () => {
    const fallback = vi.fn()
    const storage = browserProjectStorage(() => refusingStorage(), fallback)
    expect(storage.persistent).toBe(false)
    const store = createConsoleProjectStore(storage)
    store.select(store.save({ url: "https://a.example.com", token: "t" }).id)
    expect(store.active()).toMatchObject({ url: "https://a.example.com", token: "t" })
    // It was not persistent from the start, so there was no change to report.
    expect(fallback).not.toHaveBeenCalled()

    const blocked = browserProjectStorage(() => { throw new DOMException("Blocked", "SecurityError") })
    expect(blocked.persistent).toBe(false)
    expect(createConsoleProjectStore(blocked).save({ url: "https://b.example.com" }).url).toBe("https://b.example.com")
  })

  it("keeps the list in memory when a later write fails", () => {
    const fallback = vi.fn()
    // The probe write passes, and the third write (the second save) fails.
    const local = refusingStorage(3)
    const storage = browserProjectStorage(() => local, fallback)
    const store = createConsoleProjectStore(storage)
    store.save({ url: "https://a.example.com" })
    expect(storage.persistent).toBe(true)
    store.save({ url: "https://b.example.com" })
    expect(storage.persistent).toBe(false)
    expect(fallback).toHaveBeenCalledOnce()
    expect(store.list().map(project => project.url)).toEqual(["https://a.example.com", "https://b.example.com"])
  })
})

describe("project.get probe", () => {
  it("calls project.get without cookies and with the token", async () => {
    const fetch = vi.fn(json(200, projectGet))
    const probe = await probeConsoleProject(target, "secret", { fetch })
    expect(probe).toEqual({ kind: "ready", info: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv", "logs"], operations: ["kv.list"] } })
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe("https://app.example.com/portal/_vitehub/rpc")
    expect(init.credentials).toBe("same-origin")
    expect(init.headers).toEqual({ "authorization": "Bearer secret", "content-type": "application/json", [consoleRpcHeader]: "1" })
    expect(operationRpcRequest(init.body)).toEqual({ operation: "project.get", input: {} })
  })

  it("asks for a token on a 401 of auth: \"token\", also when the challenge header is hidden", async () => {
    expect(await probeConsoleProject(target, undefined, { fetch: json(401, tokenRejection) })).toEqual({ kind: "token", rejected: false })
    expect(await probeConsoleProject(target, "wrong", { fetch: json(401, tokenRejection, { "www-authenticate": 'Bearer realm="vitehub-console", error="invalid_token"' }) })).toEqual({ kind: "token", rejected: true })
    // The server keeps only the hash of the token, so the fix names the hash variable and how to replace a lost token.
    expect(consoleProjectProblem({ kind: "token", rejected: true }, { consoleOrigin: "https://console.example.com", host: "app.example.com", url: "https://app.example.com" }).message)
      .toBe("app.example.com refused this token. Use the token whose SHA-256 hash is in `VITEHUB_CONSOLE_TOKEN_SHA256`. If you lost it, create a new token and set its hash.")
  })

  it("tells OAuth and app sign-in apart from the token", async () => {
    const oauth = json(401, { code: "CONSOLE_SIGN_IN_REQUIRED" }, { "www-authenticate": 'Bearer realm="vitehub-console", resource_metadata="https://app.example.com/.well-known/oauth-protected-resource"' })
    expect(await probeConsoleProject(target, undefined, { fetch: oauth })).toEqual({ kind: "oauth", resourceMetadata: "https://app.example.com/.well-known/oauth-protected-resource" })
    const expired = json(401, { code: "CONSOLE_SIGN_IN_REQUIRED" }, { "www-authenticate": 'Bearer realm="vitehub-console", error="invalid_token", resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/_vitehub"' })
    expect(await probeConsoleProject(target, "old", { fetch: expired })).toEqual({ kind: "oauth", resourceMetadata: "https://app.example.com/.well-known/oauth-protected-resource/_vitehub" })
    const session = json(401, { code: "CONSOLE_SIGN_IN_REQUIRED" }, { "www-authenticate": 'Bearer realm="vitehub-console"' })
    expect(await probeConsoleProject(target, undefined, { fetch: session })).toEqual({ kind: "sign-in" })
  })

  it("reads a fetch TypeError as unreachable, and names console.origins", async () => {
    const probe = await probeConsoleProject(target, "secret", { fetch: async () => { throw new TypeError("Failed to fetch") } })
    expect(probe).toEqual({ kind: "unreachable" })
    expect(consoleProjectProblem({ kind: "unreachable" }, { consoleOrigin: "https://console.example.com", host: "app.example.com/portal", url: "https://app.example.com/portal" }).message)
      .toBe("app.example.com/portal did not answer this Console. If the app is online, add https://console.example.com to its `console.origins` and redeploy.")
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
    const unset = await probeConsoleProject(target, "secret", { fetch: json(500, { code: "CONSOLE_TOKEN_NOT_CONFIGURED", message: "console: { auth: \"token\" } needs VITEHUB_CONSOLE_TOKEN_SHA256 in the server environment, and it is not set.", fix: "Set VITEHUB_CONSOLE_TOKEN_SHA256.", ok: false, status: 500 }) })
    expect(unset).toEqual({ kind: "failed", status: 500, code: "CONSOLE_TOKEN_NOT_CONFIGURED", message: "console: { auth: \"token\" } needs VITEHUB_CONSOLE_TOKEN_SHA256 in the server environment, and it is not set.", fix: "Set VITEHUB_CONSOLE_TOKEN_SHA256." })
    // The fix stays its own field, so the Console shows it as its own paragraph.
    if (unset.kind !== "failed") throw new Error("expected a failed probe")
    expect(consoleProjectProblem(unset, { consoleOrigin: "https://console.example.com", host: "app.example.com", url: "https://app.example.com" })).toEqual({
      title: "app.example.com answered with an error",
      message: "console: { auth: \"token\" } needs VITEHUB_CONSOLE_TOKEN_SHA256 in the server environment, and it is not set.",
      fix: "Set VITEHUB_CONSOLE_TOKEN_SHA256.",
    })
  })
})

describe("account Console", () => {
  const linked = { id: "p-1", url: "https://app.example.com/portal", label: "Docs", tokenSha256: "a".repeat(64), tokenVariable: "VITEHUB_CONSOLE_TOKEN_SHA256_CONSOLE_P1" }

  async function account(fetch: (url: string, init: RequestInit) => Promise<Response>) {
    vi.stubGlobal("fetch", operationRpcFetch(fetch))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const storage = memoryProjectStorage()
    storage.setItem(consoleProjectsStorageKey, JSON.stringify({ active: linked.id, projects: [{ id: linked.id, url: linked.url, label: linked.label }] }))
    const state = module.startConsoleProjects({ base: "", home: "/", mode: "account", navigate: vi.fn(), pageOrigin: "https://console.example.com", storage })
    state.account.value = { user: { id: "u", name: "Ada", email: "ada@example.com" }, hasEmail: true, teams: [{ id: "t", name: "Personal", slug: "personal-u" }], teamId: "t", roles: ["owner"], projects: [linked] }
    return { module, state }
  }

  it("sends the project's calls to the Console server, with the page cookies and no token", async () => {
    const fetch = vi.fn(json(200, { ok: true, value: { protocol: 1, name: "Docs", operations: [], sections: [] } }))
    const { module, state } = await account(fetch)
    await module.openConsoleProject()
    expect(state.gate.value).toEqual({ kind: "ready" })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/p/p-1/_vitehub/rpc")
    expect(init.credentials).toBe("same-origin")
    expect(new Headers(init.headers).has("authorization")).toBe(false)
    // project-session imported its own copy of the transport after the module reset.
    const transport = await import("../src/console/runtime/client/project.ts")
    expect(transport.consoleProject()).toMatchObject({ origin: "", base: "/p/p-1", remote: true })
    expect(transport.isRemoteProject()).toBe(true)
  })

  it("keeps media and provider sign-in links on the app while forwarding data requests", async () => {
    const { module } = await account(json(200, { ok: true, value: { protocol: 1, name: "Docs", operations: [], sections: [] } }))
    await module.openConsoleProject()
    const media = await import("../src/console/runtime/client/media-library.ts")
    const connections = await import("../src/console/runtime/client/connections-management.ts")
    const transport = await import("../src/console/runtime/client/project.ts")
    expect(media.consoleMediaUrl("/portal/images/", "photo.png")).toBe("https://app.example.com/portal/images/photo.png")
    expect(connections.connectionConnectURL("/_vitehub/api/connections", "github", "/home")).toBe("https://app.example.com/portal/_vitehub/api/connections/connect/github")
    expect(transport.projectAppUrl("/_vitehub/connections")).toBe("https://app.example.com/portal/_vitehub/connections")
    expect(transport.projectAppUrl("/_vitehub/mcp")).toBe("https://app.example.com/portal/_vitehub/mcp")
    expect(transport.projectUrl("/_vitehub/rpc")).toBe("/p/p-1/_vitehub/rpc")
  })

  it("shows the variable to set while the project has no hash, or another one", async () => {
    for (const answer of [
      json(500, { code: "CONSOLE_TOKEN_NOT_CONFIGURED", message: "not set", ok: false, status: 500 }),
      json(401, { code: "CONSOLE_TOKEN_INVALID", message: "refused", ok: false, status: 401 }),
    ]) {
      const { module, state } = await account(answer)
      await module.openConsoleProject()
      expect(state.gate.value).toEqual({ kind: "setup", project: linked })
      vi.resetModules()
    }
  })

  it("starts with the empty state when the team has no project", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const module = await import("../src/console/runtime/client/project-session.ts")
    const state = module.startConsoleProjects({ base: "", home: "/", mode: "account", navigate: vi.fn(), pageOrigin: "https://console.example.com", storage: memoryProjectStorage() })
    expect(state.gate.value).toEqual({ kind: "empty" })
    // The Console server keeps the list, so the page never says that it ends with the page.
    expect(state.persistent.value).toBe(true)
  })

  it("shows an account page in place before a project opens, and loads it from an open project", async () => {
    const { module, state } = await account(json(200, { ok: true, value: { protocol: 1, name: "Docs", operations: [], sections: [] } }))
    state.gate.value = { kind: "empty" }
    module.showConsoleAccountPage("team")
    expect(state.gate.value).toEqual({ kind: "home", page: "team" })
    expect(state.navigate).not.toHaveBeenCalled()

    await module.openConsoleProject()
    expect(state.gate.value).toEqual({ kind: "ready" })
    // The router owns the path of an open project, so the Console loads the page.
    module.showConsoleAccountPage("settings")
    expect(state.navigate).toHaveBeenCalledWith("/settings")

    module.openAccountProject(linked.id)
    expect(state.navigate).toHaveBeenLastCalledWith("/")
  })

  describe.each(["home", "team", "settings"] as const)("while %s is selected", (page) => {
    it.each([200, 401])("ignores a late %s app response", async (status) => {
      const pending = pendingResponse()
      const { module, state } = await account(() => pending.promise)
      state.openingView = "shell"
      const opening = module.openConsoleProject()
      expect(state.gate.value).toEqual({ kind: "opening" })

      module.showConsoleAccountPage(page)
      pending.resolve(Response.json(status === 200 ? projectGet : tokenRejection, { status }))
      await opening

      expect(state.gate.value).toEqual({ kind: "home", page })
      expect(state.info.value).toBeUndefined()
      expect(state.navigate).not.toHaveBeenCalled()
    })
  })

  it.each([200, 401])("uses a late %s app response when the user stays on the opening view", async (status) => {
    const pending = pendingResponse()
    const { module, state } = await account(() => pending.promise)
    state.openingView = "shell"
    const opening = module.openConsoleProject()
    expect(state.gate.value).toEqual({ kind: "opening" })

    pending.resolve(Response.json(status === 200 ? projectGet : tokenRejection, { status }))
    await opening

    expect(state.gate.value).toEqual(status === 200 ? { kind: "ready" } : { kind: "setup", project: linked })
  })
})

describe("linking a project", () => {
  async function session(fetch: (url: string, init: RequestInit) => Promise<Response>, pageOrigin = "https://console.example.com", storage = memoryProjectStorage()) {
    vi.stubGlobal("fetch", operationRpcFetch(fetch))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const navigate = vi.fn()
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
    // Nothing has loaded yet, so the first project opens in place.
    module.switchConsoleProject(linked.project.id)
    await module.consoleProjectReady()
    expect(navigate).not.toHaveBeenCalled()
    expect(state.gate.value).toEqual({ kind: "ready" })

    // Once the Console shows a project, a switch loads the Console again, so no page keeps data of the last project.
    const other = await module.linkConsoleProject("https://other.example.com", "right")
    if (other.kind !== "linked") throw new Error("Expected a linked project")
    module.switchConsoleProject(other.project.id)
    expect(navigate).toHaveBeenCalledWith("/")
    expect(state.store.active()?.url).toBe("https://other.example.com")
  })

  it("explains CORS, mixed content, and a bad URL without saving", async () => {
    const { module, state } = await session(async () => { throw new TypeError("Failed to fetch") })
    expect(await module.linkConsoleProject("https://app.example.com")).toEqual({
      kind: "problem",
      problem: { title: "Cannot reach app.example.com", message: "app.example.com did not answer this Console. If the app is online, add https://console.example.com to its `console.origins` and redeploy." },
    })
    expect(await module.linkConsoleProject("http://app.example.com")).toMatchObject({ kind: "problem", problem: { title: "Use HTTPS" } })
    expect(await module.linkConsoleProject("ftp://app.example.com")).toMatchObject({ kind: "problem", problem: { title: "Check the URL" } })
    expect(state.store.list()).toEqual([])
  })

  it("opens the active project with its token and sends every request there", async () => {
    const fetch = vi.fn(async () => Response.json(projectGet))
    vi.stubGlobal("fetch", operationRpcFetch(fetch))
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
    expect(projectUrl("/_vitehub/rpc")).toBe("https://b.example.com/_vitehub/rpc")
    expect(await active().authorization?.()).toBe("Bearer token-b")
  })

  it.each(["https:", "http:"])("signs in to an embedded token app over %s", async (protocol) => {
    if (protocol === "http:") vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get("authorization") === "Bearer right" ? Response.json(projectGet) : Response.json(tokenRejection, { status: 401 }))
    vi.stubGlobal("fetch", operationRpcFetch(fetch))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const storage = memoryProjectStorage()
    const state = module.startConsoleProjects({ base: "/portal", home: "/portal/_vitehub/", mode: "embedded", navigate: () => {}, pageOrigin: `${protocol}//app.example.com`, storage })

    await module.openConsoleProject()
    expect(state.gate.value).toEqual({ kind: "token", rejected: false })
    // The embedded Console calls its own origin, so the request path has no origin.
    expect(fetch.mock.calls[0]![0]).toBe("/portal/_vitehub/rpc")
    expect(await module.signInConsoleProject("wrong")).toEqual({ kind: "token", rejected: true })
    expect(await module.signInConsoleProject("right")).toEqual({ kind: "ready" })
    expect(createConsoleProjectStore(storage).find(`${protocol}//app.example.com/portal`)?.token).toBe("right")
  })

  it.each(["before", "after"])("ignores a stale boot probe that finishes %s the selected project's probe", async (order) => {
    const responseA = pendingResponse()
    const responseB = pendingResponse()
    const storage = memoryProjectStorage()
    const store = createConsoleProjectStore(storage)
    const a = store.save({ url: "https://a.example.com", label: "A", token: "token-a" })
    const b = store.save({ url: "https://b.example.com", label: "B", token: "token-b" })
    store.select(a.id)
    const { module, state } = await session(url => url.startsWith("https://a.example.com") ? responseA.promise : responseB.promise, undefined, storage)
    const openingA = module.openConsoleProject()
    module.switchConsoleProject(b.id)

    if (order === "after") {
      responseB.resolve(Response.json(tokenRejection, { status: 401 }))
      await vi.waitFor(() => expect(state.gate.value).toEqual({ kind: "token", rejected: true }))
    }
    responseA.resolve(Response.json(projectGet))
    await openingA
    expect(state.gate.value).toEqual(order === "before" ? { kind: "opening" } : { kind: "token", rejected: true })
    expect(state.info.value).toBeUndefined()
    expect(state.current.value).toEqual(b)
    expect(state.store.get(b.id)).toEqual(b)
    expect(state.store.active()?.id).toBe(b.id)
    const { consoleProject: active } = await import("../src/console/runtime/client/project.ts")
    expect(active().origin).toBe("https://b.example.com")
    expect(await active().authorization?.()).toBe("Bearer token-b")

    responseB.resolve(Response.json(tokenRejection, { status: 401 }))
    await vi.waitFor(() => expect(state.gate.value).toEqual({ kind: "token", rejected: true }))
  })

  it("ignores a token sign-in result after switching projects", async () => {
    const responseA = pendingResponse()
    const { module, state } = await session((_url, init) => new Headers(init.headers).get("authorization") === "Bearer token-a" ? responseA.promise : json(401, tokenRejection)(_url, init))
    const a = state.store.save({ url: "https://a.example.com", label: "A" })
    const b = state.store.save({ url: "https://b.example.com", label: "B" })
    module.switchConsoleProject(a.id)
    await vi.waitFor(() => expect(state.gate.value).toEqual({ kind: "token", rejected: false }))
    const signInA = module.signInConsoleProject("token-a")
    module.switchConsoleProject(b.id)
    await vi.waitFor(() => expect(state.gate.value).toEqual({ kind: "token", rejected: false }))

    responseA.resolve(Response.json(projectGet))
    await signInA
    expect(state.gate.value).toEqual({ kind: "token", rejected: false })
    expect(state.info.value).toBeUndefined()
    expect(state.current.value).toEqual(b)
    expect(state.store.get(a.id)?.token).toBeUndefined()
    expect(state.store.get(b.id)).toEqual(b)
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

describe("projects in a browser that refuses writes", () => {
  it("links the first project and opens it in place, so the list in memory stays", async () => {
    vi.stubGlobal("fetch", operationRpcFetch(vi.fn(async () => Response.json(projectGet))))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const navigate = vi.fn()
    const storage = browserProjectStorage(() => refusingStorage())
    const state = module.startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate, pageOrigin: "https://console.example.com", storage })
    expect(state.persistent.value).toBe(false)

    const linked = await module.linkConsoleProject("https://app.example.com", "token")
    if (linked.kind !== "linked") throw new Error("Expected a linked project")
    module.switchConsoleProject(linked.project.id)
    await module.consoleProjectReady()
    expect(navigate).not.toHaveBeenCalled()
    expect(state.gate.value).toEqual({ kind: "ready" })
    expect(state.current.value).toMatchObject({ url: "https://app.example.com", token: "token" })
    const { useConsoleToast } = await import("../src/console/runtime/client/toast.ts")
    expect(useConsoleToast().toasts.value.map(toast => toast.title)).toEqual([module.consoleProjectsVolatileNote])
  })

  it("signs in to an embedded token app when the first write fails", async () => {
    vi.stubGlobal("fetch", operationRpcFetch(vi.fn(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get("authorization") === "Bearer right" ? Response.json(projectGet) : Response.json(tokenRejection, { status: 401 }))))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const fallback = vi.fn(() => module.noteConsoleProjectsVolatile())
    // The probe passes, so storage looks fine until the token is saved.
    const storage = browserProjectStorage(() => refusingStorage(2), fallback)
    const state = module.startConsoleProjects({ base: "", home: "/_vitehub/", mode: "embedded", navigate: () => {}, pageOrigin: "https://app.example.com", storage })
    await module.openConsoleProject()
    expect(state.gate.value).toEqual({ kind: "token", rejected: false })
    expect(await module.signInConsoleProject("right")).toEqual({ kind: "ready" })
    expect(fallback).toHaveBeenCalledOnce()
    expect(state.persistent.value).toBe(false)
    expect(state.current.value?.token).toBe("right")
  })
})

describe("remote project links", () => {
  it.each([
    ["", false],
    ["https://app.example.com", false],
    ["https://other.example.com", true],
    ["http://app.example.com", true],
    ["https://app.example.com:8443", true],
  ])("classifies project origin %j against the page origin", (origin, remote) => {
    vi.stubGlobal("location", new URL("https://app.example.com/console/"))
    setConsoleProject({ origin, base: "/portal" })
    expect(isRemoteProject()).toBe(remote)
  })

  it("allows Env management for a same-origin project and blocks another origin", async () => {
    vi.stubGlobal("location", new URL("https://app.example.com/console/"))
    const fetch = vi.fn(json(200, { events: [] }))
    vi.stubGlobal("fetch", operationRpcFetch(fetch))
    setConsoleProject({ origin: "https://app.example.com", base: "/portal" })
    await expect(requestEnvManagement("/_vitehub/env/manage", "env.server.token", "activity", envActivitySchema)).resolves.toEqual({ events: [] })
    expect(fetch).toHaveBeenCalledWith("https://app.example.com/portal/_vitehub/env/manage", expect.objectContaining({ credentials: "same-origin", method: "POST" }))

    setConsoleProject({ origin: "https://other.example.com", base: "/portal" })
    await expect(requestEnvManagement("/_vitehub/env/manage", "env.server.token", "activity", envActivitySchema)).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("tells when the Console shows a project on another origin", () => {
    expect(isRemoteProject()).toBe(false)
    setConsoleProject({ origin: "https://app.example.com", base: "/portal" })
    expect(isRemoteProject()).toBe(true)
  })
})
