import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleProject, isRemoteProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { consoleProjectBuildOf, consoleProjectProblem, probeConsoleProject } from "../src/console/runtime/client/project-link.ts"
import { consoleProjectHost, consoleProjectsStorageKey, createConsoleProjectStore, memoryProjectStorage, normalizeProjectUrl } from "../src/console/runtime/client/projects.ts"
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
/** The Console's fetch with the account read of `/api/account`: the session, or 401 signed out. Other calls go to `app`. */
const withAccount = (account: () => unknown, app: (url: string, init: RequestInit) => Promise<Response>) =>
  operationRpcFetch(async (url: string, init: RequestInit) => {
    if (url !== "/api/account") return await app(url, init)
    const session = account()
    return session ? Response.json(session) : Response.json({ code: "UNAUTHORIZED", message: "Sign in." }, { status: 401 })
  })
const projectGet = { ok: true, value: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv", "logs"], operations: ["kv.list"] } }
const signatureRejection = { code: "CONSOLE_KEY_UNKNOWN", message: "The request was signed with the key `CONSOLE_P1`, and this app has no `VITEHUB_CONSOLE_KEY_CONSOLE_P1`.", ok: false, status: 401 }

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

  it("shows the host and mount", () => {
    expect(consoleProjectHost({ url: "https://app.example.com/portal" })).toBe("app.example.com/portal")
  })
})

describe("project store", () => {
  it("saves and selects a project when randomUUID is unavailable on HTTP", () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    const store = createConsoleProjectStore(memoryProjectStorage())
    const project = store.save({ url: "http://app.example.com" })
    store.select(project.id)
    expect(project.id).toBeTruthy()
    expect(store.active()).toEqual(project)
    expect(store.save({ url: project.url, label: "Shop" }).id).toBe(project.id)
    expect(store.save({ url: "http://other.example.com" }).id).not.toBe(project.id)
  })

  it("links, updates, selects, and forgets projects in one storage key", () => {
    const storage = memoryProjectStorage()
    const store = createConsoleProjectStore(storage)

    const a = store.save({ url: "https://a.example.com", label: "A" })
    const b = store.save({ url: "https://b.example.com/portal" })
    store.select(b.id)
    expect(store.list().map(project => project.url)).toEqual(["https://a.example.com", "https://b.example.com/portal"])
    expect(store.active()?.id).toBe(b.id)

    // The same URL updates the project.
    expect(store.save({ url: "https://a.example.com", label: "Shop" })).toEqual({ id: a.id, url: "https://a.example.com", label: "Shop" })
    expect(store.list()).toHaveLength(2)

    // A second store on the same storage reads the same list.
    expect(createConsoleProjectStore(storage).find("https://b.example.com/portal")?.id).toBe(b.id)

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
        { id: "a", url: "https://a.example.com/", label: " A " },
        { id: "a", url: "https://other.example.com" },
        { id: "b", url: "javascript:alert(1)" },
        { url: "https://c.example.com" },
        "text",
      ],
    }))
    const store = createConsoleProjectStore(storage)
    expect(store.list()).toEqual([{ id: "a", url: "https://a.example.com", label: "A" }])
    expect(store.active()).toBeUndefined()

    storage.setItem(consoleProjectsStorageKey, "{not json")
    expect(store.list()).toEqual([])
  })
})

describe("project.get probe", () => {
  it("calls project.get without cookies and without authorization", async () => {
    const fetch = vi.fn(json(200, projectGet))
    const probe = await probeConsoleProject(target, { fetch })
    expect(probe).toEqual({ kind: "ready", info: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv", "logs"], operations: ["kv.list"] } })
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe("https://app.example.com/portal/_vitehub/rpc")
    expect(init.credentials).toBe("same-origin")
    expect(init.headers).toEqual({ "content-type": "application/json", [consoleRpcHeader]: "1" })
    expect(operationRpcRequest(init.body)).toEqual({ operation: "project.get", input: {} })
  })

  it("reads the build of the project, and drops a build without a valid time", async () => {
    const commit = { author: "Ada", branch: "main", message: "feat: ship", sha: "4f9c2e1" }
    const built = await probeConsoleProject(target, { fetch: json(200, { ok: true, value: { ...projectGet.value, build: { commit: { ...commit, extra: 1 }, time: "2026-11-14T10:00:00.000Z" } } }) })
    expect(built).toMatchObject({ kind: "ready", info: { build: { commit, time: "2026-11-14T10:00:00.000Z" } } })
    const broken = await probeConsoleProject(target, { fetch: json(200, { ok: true, value: { ...projectGet.value, build: { commit, time: "yesterday" } } }) })
    expect(broken.kind === "ready" && broken.info).not.toHaveProperty("build")
    expect(consoleProjectBuildOf({ commit: { message: "no sha" }, time: "2026-11-14T10:00:00.000Z" })).toEqual({ time: "2026-11-14T10:00:00.000Z" })
  })

  it("keeps the build of a connected app from the check of the Console server", async () => {
    const build = { commit: { sha: "4f9c2e1" }, time: "2026-11-14T10:00:00.000Z" }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ answer: { ...projectGet.value, build }, linked: true, status: 200 })))
    const { checkConsoleAccountProject } = await import("../src/console/runtime/client/account.ts")
    expect(await checkConsoleAccountProject("p-1")).toEqual({ build, code: 200, status: "connected" })
  })

  it("reads a refused signature by its code, and any other 401 as a refused signature", async () => {
    const missing = { code: "CONSOLE_SIGNATURE_MISSING", fix: "Open the app from the ViteHub Console.", message: "This request is not signed.", ok: false, status: 401 }
    expect(await probeConsoleProject(target, { fetch: json(401, missing) })).toEqual({ kind: "signed", code: "CONSOLE_SIGNATURE_MISSING", fix: "Open the app from the ViteHub Console.", message: "This request is not signed." })
    expect(await probeConsoleProject(target, { fetch: json(401, signatureRejection, { "www-authenticate": "VitehubSignature realm=\"vitehub-console\"" }) })).toMatchObject({ kind: "signed", code: "CONSOLE_KEY_UNKNOWN" })
    expect(await probeConsoleProject(target, { fetch: json(401, { message: "Sign in." }) })).toEqual({ kind: "signed", code: "CONSOLE_SIGNATURE_INVALID", message: "Sign in." })
    expect(consoleProjectProblem({ kind: "signed", code: "CONSOLE_SIGNATURE_MISSING" }, { host: "app.example.com", url: "https://app.example.com" }).message)
      .toBe("app.example.com refused the signature of this Console. Set the VITEHUB_CONSOLE_KEY_<NAME> line that the Console shows for this app.")
  })

  it("reads a fetch TypeError as unreachable", async () => {
    const probe = await probeConsoleProject(target, { fetch: async () => { throw new TypeError("Failed to fetch") } })
    expect(probe).toEqual({ kind: "unreachable" })
    expect(consoleProjectProblem({ kind: "unreachable" }, { host: "app.example.com/portal", url: "https://app.example.com/portal" }).message)
      .toBe("app.example.com/portal did not answer this Console. Check that the app is online at https://app.example.com/portal.")
  })

  it("lets an abort through", async () => {
    const abort = new DOMException("Aborted", "AbortError")
    await expect(probeConsoleProject(target, { fetch: async () => { throw abort } })).rejects.toBe(abort)
  })

  it("blocks another protocol and a vite-hub without project.get", async () => {
    const newer = await probeConsoleProject(target, { fetch: json(200, { ok: true, value: { protocol: 2, vitehub: "0.4.0" } }) })
    expect(newer).toEqual({ kind: "protocol", protocol: 2, vitehub: "0.4.0" })
    const context = { host: "app.example.com", url: "https://app.example.com" }
    if (newer.kind !== "protocol") throw new Error("Expected a protocol probe")
    expect(consoleProjectProblem(newer, context).message).toBe("This project runs vite-hub 0.4.0. This Console needs protocol 1. Update vite-hub.")

    const older = await probeConsoleProject(target, { fetch: json(404, { code: "CONSOLE_NOT_FOUND", message: "Console operation not found.", ok: false, status: 404 }) })
    expect(older).toEqual({ kind: "protocol" })
    expect(consoleProjectProblem({ kind: "protocol" }, context).message).toBe("This project runs an older vite-hub. This Console needs protocol 1. Update vite-hub.")
  })

  it("names a URL without a Console and a server error with its fix", async () => {
    expect(await probeConsoleProject(target, { fetch: async () => new Response("Not found", { status: 404 }) })).toEqual({ kind: "missing" })
    const unset = await probeConsoleProject(target, { fetch: json(500, { code: "CONSOLE_KEY_NOT_CONFIGURED", message: "The app needs a VITEHUB_CONSOLE_KEY_<NAME> variable in the server environment, and none is set.", fix: "Set VITEHUB_CONSOLE_KEY_<NAME>.", ok: false, status: 500 }) })
    expect(unset).toEqual({ kind: "failed", status: 500, code: "CONSOLE_KEY_NOT_CONFIGURED", message: "The app needs a VITEHUB_CONSOLE_KEY_<NAME> variable in the server environment, and none is set.", fix: "Set VITEHUB_CONSOLE_KEY_<NAME>." })
    // The fix stays its own field, so the Console shows it as its own paragraph.
    if (unset.kind !== "failed") throw new Error("expected a failed probe")
    expect(consoleProjectProblem(unset, { host: "app.example.com", url: "https://app.example.com" })).toEqual({
      title: "app.example.com answered with an error",
      message: "The app needs a VITEHUB_CONSOLE_KEY_<NAME> variable in the server environment, and none is set.",
      fix: "Set VITEHUB_CONSOLE_KEY_<NAME>.",
    })
  })
})

describe("account Console", () => {
  const linked = { id: "p-1", url: "https://app.example.com/portal", label: "Docs", publicKey: "a".repeat(43), keyVariable: "VITEHUB_CONSOLE_KEY_CONSOLE_P1" }

  async function account(fetch: (url: string, init: RequestInit) => Promise<Response>) {
    vi.stubGlobal("fetch", operationRpcFetch(fetch))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const storage = memoryProjectStorage()
    storage.setItem(consoleProjectsStorageKey, JSON.stringify({ active: linked.id, projects: [{ id: linked.id, url: linked.url, label: linked.label }] }))
    const state = module.startConsoleProjects({ base: "", home: "/", mode: "account", navigate: vi.fn(), pageOrigin: "https://console.example.com", storage })
    state.account.value = { user: { id: "u", name: "Ada", email: "ada@example.com" }, hasEmail: true, teams: [{ id: "t", name: "Personal", slug: "personal-u" }], teamId: "t", roles: ["owner"], projects: [linked] }
    return { module, state }
  }

  it("opens the page of a hostedConsoleUrl() link in the app of the team with that URL", async () => {
    const { consoleOpenLink } = await import("../src/console/runtime/client/project-session.ts")
    const { hostedConsoleUrl } = await import("@vite-hub/runtime")
    const projects = [linked, { id: "p-2", url: "https://other.example.com" }]
    const search = (project: string, path: string) => new URL(hostedConsoleUrl(project, path, "https://console.example.com")).search
    expect(new URL(hostedConsoleUrl("https://app.example.com/portal", "/kv", "https://console.example.com")).pathname).toBe("/open")
    expect(consoleOpenLink(search("https://app.example.com/portal/", "/agents/bot/invocations/abc?tab=trace"), projects)).toEqual({ id: "p-1", path: "/agents/bot/invocations/abc?tab=trace" })
    expect(consoleOpenLink(search("https://other.example.com", "/_vitehub/kv"), projects)).toEqual({ id: "p-2", path: "/kv" })
    // An app that the team did not link, and paths that could leave the Console, open nothing.
    expect(consoleOpenLink(search("https://unknown.example.com", "/kv"), projects)).toBeUndefined()
    for (const path of ["//evil.example", "https://evil.example", "/\\evil.example"])
      expect(consoleOpenLink(`?project=${encodeURIComponent(linked.url)}&path=${encodeURIComponent(path)}`, projects), path).toBeUndefined()
  })

  it("keeps a hostedConsoleUrl() link through GitHub and passkey sign-in, then opens its page", async () => {
    const { hostedConsoleUrl } = await import("@vite-hub/runtime")
    const link = new URL(hostedConsoleUrl("https://app.example.com/portal", "/agents/bot/invocations/abc", "https://console.example.com"))
    let session: import("../src/console/runtime/client/account.ts").ConsoleAccount | undefined
    vi.stubGlobal("fetch", vi.fn(async () => session ? Response.json(session) : Response.json({ code: "UNAUTHORIZED", message: "Sign in." }, { status: 401 })))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const navigate = vi.fn()
    const boot = { home: "/", navigate, pageOrigin: "https://console.example.com", pathname: link.pathname, search: link.search, showPath: () => {} }
    // Signed out, the sign-in page keeps the link.
    expect(await module.startConsoleAccount(boot)).toBeUndefined()
    const returnTo = `/open?project=${encodeURIComponent("https://app.example.com/portal")}&path=${encodeURIComponent("/agents/bot/invocations/abc")}`
    expect(module.useConsoleProjects().gate.value).toEqual({ kind: "account", returnTo })
    // GitHub calls back to the link, and a passkey sign-in on this page opens it.
    expect(module.consoleSignInReturnPath()).toBe(returnTo)
    module.finishConsoleSignIn()
    expect(navigate).toHaveBeenLastCalledWith(returnTo)
    // Signed in, the link opens the page in the app of the team.
    session = { user: { id: "u", name: "Ada", email: "ada@example.com" }, hasEmail: true, teams: [{ id: "t", name: "Personal", slug: "personal-u" }], teamId: "t", roles: ["owner"], projects: [linked] }
    const back = new URL(returnTo, "https://console.example.com")
    expect(await module.startConsoleAccount({ ...boot, pathname: back.pathname, search: back.search })).toBe("/agents/bot/invocations/abc")
    // A link with a path that could leave the Console is not kept, so the sign-in opens Home.
    session = undefined
    await module.startConsoleAccount({ ...boot, search: `?project=${encodeURIComponent(linked.url)}&path=${encodeURIComponent("//evil.example")}` })
    expect(module.consoleSignInReturnPath()).toBe("/")
  })

  it("signs the browser in to the app of a /_vitehub link and goes back to the page, through a sign-in", async () => {
    const state = "s".repeat(43)
    const search = `?project=${encodeURIComponent("https://app.example.com/portal")}&site=${encodeURIComponent("/runs/42")}&state=${state}`
    let session: import("../src/console/runtime/client/account.ts").ConsoleAccount | undefined
    const fetch = vi.fn(json(200, { ok: true, value: { url: `https://app.example.com/portal/_vitehub/rpc?ticket=vt1_${"t".repeat(43)}`, expiresAt: "2026-11-14T00:00:00.000Z" } }))
    vi.stubGlobal("fetch", withAccount(() => session, fetch))
    const replace = vi.fn()
    vi.stubGlobal("location", { replace })
    const module = await import("../src/console/runtime/client/project-session.ts")
    const boot = { home: "/", navigate: vi.fn(), pageOrigin: "https://console.example.com", pathname: "/open", search, showPath: () => {} }
    // Signed out, the sign-in keeps the page and the state of the link.
    await module.startConsoleAccount(boot)
    const returnTo = module.consoleSignInReturnPath()
    expect(new URL(returnTo, "https://console.example.com").searchParams.get("site")).toBe("/runs/42")
    expect(new URL(returnTo, "https://console.example.com").searchParams.get("state")).toBe(state)
    // Signed in, the Console asks the app for a link bound to the state, and replaces the page with it.
    session = { user: { id: "u", name: "Ada", email: "ada@example.com" }, hasEmail: true, teams: [{ id: "t", name: "Personal", slug: "personal-u" }], teamId: "t", roles: ["owner"], projects: [linked] }
    const back = new URL(returnTo, "https://console.example.com")
    await module.startConsoleAccount({ ...boot, search: back.search })
    expect(module.useConsoleProjects().gate.value).toEqual({ kind: "site", page: "/runs/42", state })
    await module.openConsoleSite()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/p/p-1/_vitehub/rpc")
    expect(JSON.parse(String(init.body))).toMatchObject({ m: "site.link", a: [{ path: "/runs/42", state }] })
    expect(replace).toHaveBeenCalledWith(`https://app.example.com/portal/_vitehub/rpc?ticket=vt1_${"t".repeat(43)}`)
  })

  it("keeps the hash of the app page, which the browser kept through the /_vitehub redirect", async () => {
    const state = "s".repeat(43)
    vi.stubGlobal("fetch", withAccount(() => undefined, json(500, {})))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const search = `?project=${encodeURIComponent("https://app.example.com/portal")}&site=${encodeURIComponent("/runs/42?tab=logs")}&state=${state}`
    await module.startConsoleAccount({ home: "/", navigate: vi.fn(), pageOrigin: "https://console.example.com", pathname: "/open", search, hash: "#step-3", showPath: () => {} })
    expect(new URL(module.consoleSignInReturnPath(), "https://console.example.com").searchParams.get("site")).toBe("/runs/42?tab=logs#step-3")
  })

  it("follows only a ticket link of the app that it opened", async () => {
    const { siteTicketUrl } = await import("../src/console/runtime/client/project-session.ts")
    const ticket = `vt1_${"t".repeat(43)}`
    expect(siteTicketUrl(`https://app.example.com/portal/_vitehub/rpc?ticket=${ticket}`, linked.url)).toBe(`https://app.example.com/portal/_vitehub/rpc?ticket=${ticket}`)
    for (const url of [
      `https://evil.example/portal/_vitehub/rpc?ticket=${ticket}`,
      `https://app.example.com/_vitehub/rpc?ticket=${ticket}`,
      `https://app.example.com/portal/elsewhere?ticket=${ticket}`,
      "https://app.example.com/portal/_vitehub/rpc?ticket=short",
      "javascript:alert(1)",
      42,
    ]) expect(siteTicketUrl(url, linked.url), String(url)).toBeUndefined()
  })

  it("says why a /_vitehub link did not sign the browser in", async () => {
    const state = "s".repeat(43)
    const session = { user: { id: "u", name: "Ada", email: "ada@example.com" }, hasEmail: true, teams: [{ id: "t", name: "Personal", slug: "personal-u" }], teamId: "t", roles: ["owner"], projects: [linked] }
    const fetch = vi.fn(json(404, { ok: false, status: 404, code: "CONSOLE_REQUEST_FAILED", message: "Site access signs browsers in with ViteHub Auth, and the app has no Auth section." }))
    vi.stubGlobal("fetch", withAccount(() => session, fetch))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const boot = { home: "/", navigate: vi.fn(), pageOrigin: "https://console.example.com", pathname: "/open", showPath: () => {} }
    // An app that is no project of the team.
    await module.startConsoleAccount({ ...boot, search: `?project=${encodeURIComponent("https://unknown.example.com")}&site=%2F&state=${state}` })
    expect(module.useConsoleProjects().gate.value).toEqual({ kind: "site-refused", url: "https://unknown.example.com", page: "/", linked: false })
    // An app that refuses: the Console shows the app's reason.
    await module.startConsoleAccount({ ...boot, search: `?project=${encodeURIComponent(linked.url)}&site=%2Fdocs&state=${state}` })
    await module.openConsoleSite()
    expect(module.useConsoleProjects().gate.value).toMatchObject({ kind: "site-refused", url: linked.url, page: "/docs", linked: true, message: expect.stringContaining("no Auth section") })
    // A link without a valid state, or with a page that leaves the app, is no site link.
    expect(module.consoleSiteLink(`?project=${encodeURIComponent(linked.url)}&site=%2F&state=short`)).toBeUndefined()
    expect(module.consoleSiteLink(`?project=${encodeURIComponent(linked.url)}&site=${encodeURIComponent("//evil.example")}&state=${state}`)).toBeUndefined()
  })

  it("boots with one account read that matches the HTML preload, and sends project.get of the last app at the same time", async () => {
    const { consoleAccountPath: preloadPath } = await import("../../console/src/page.ts")
    const stored = new Map([["vitehub-console:last-project", linked.id]])
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) })
    const session = { user: { id: "u", name: "Ada", email: "ada@example.com", image: null }, hasEmail: true, teams: [{ id: "t", name: "Personal", slug: "personal-u" }], teamId: "t", roles: ["owner"], projects: [linked] }
    const navigation = { sections: ["kv"], projectName: "Docs" }
    const account = pendingResponse()
    const sent: string[] = []
    const fetch = vi.fn(operationRpcFetch(async (url: string, init: RequestInit) => {
      if (url === preloadPath) {
        sent.push(`account ${JSON.stringify(init)}`)
        return account.promise
      }
      const { operation } = operationRpcRequest(init.body)
      sent.push(`${operation} ${url}`)
      return Response.json({ ok: true, value: { ...projectGet.value, navigation } })
    }))
    vi.stubGlobal("fetch", fetch)
    const module = await import("../src/console/runtime/client/project-session.ts")
    const starting = module.startConsoleAccount({ boot: "app", home: "/", navigate: vi.fn(), pageOrigin: "https://console.example.com", pathname: "/", search: "", showPath: () => {} })
    // project.get of the app that this browser opened last does not wait for the account.
    await vi.waitFor(() => expect(sent).toContain("project.get /p/p-1/_vitehub/rpc"))
    // One request with no headers and no cache option, so the browser reuses the answer of `<link rel="preload" as="fetch">`.
    expect(sent).toContain(`account ${JSON.stringify({ credentials: "same-origin" })}`)
    account.resolve(Response.json(session))
    await starting
    const state = module.useConsoleProjects()
    expect(state.account.value).toEqual(session)
    expect(state.gate.value).toEqual({ kind: "opening" })
    await module.openConsoleProject()
    expect(state.gate.value).toEqual({ kind: "ready" })
    // The early answer opened the app, and the sections came with it.
    const sections = await import("../src/console/runtime/client/sections.ts")
    expect((await sections.loadConsoleNavigation(sections.consoleSectionsPath))?.sections).toEqual(["kv"])
    expect(sent.filter(call => !call.startsWith("account"))).toEqual(["project.get /p/p-1/_vitehub/rpc"])
  })

  it("asks again when the early project.get was for another app, and reads sections.list from an app that does not send them", async () => {
    const stored = new Map([["vitehub-console:last-project", "p-gone"]])
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) })
    const session = { user: { id: "u", name: "Ada", email: "ada@example.com", image: null }, hasEmail: true, teams: [], teamId: "t", roles: ["owner"], projects: [linked] }
    const sent: string[] = []
    vi.stubGlobal("fetch", vi.fn(operationRpcFetch(async (url: string, init: RequestInit) => {
      if (url === "/api/account") return Response.json(session)
      const { operation } = operationRpcRequest(init.body)
      sent.push(`${operation} ${url}`)
      if (url.startsWith("/p/p-gone/")) return Response.json({ code: "CONSOLE_PROJECT_NOT_FOUND", message: "There is no such project.", ok: false, status: 404 }, { status: 404 })
      return Response.json(operation === "project.get" ? projectGet : { ok: true, value: { sections: ["logs"] } })
    })))
    const module = await import("../src/console/runtime/client/project-session.ts")
    await module.startConsoleAccount({ boot: "app", home: "/", navigate: vi.fn(), pageOrigin: "https://console.example.com", pathname: "/", search: "", showPath: () => {} })
    await module.openConsoleProject()
    expect(module.useConsoleProjects().gate.value).toEqual({ kind: "ready" })
    const sections = await import("../src/console/runtime/client/sections.ts")
    expect((await sections.loadConsoleNavigation(sections.consoleSectionsPath))?.sections).toEqual(["logs"])
    expect(sent).toEqual(["project.get /p/p-gone/_vitehub/rpc", "project.get /p/p-1/_vitehub/rpc", "sections.list /p/p-1/_vitehub/rpc"])
    // The app that opened is the next guess.
    expect(stored.get("vitehub-console:last-project")).toBe("p-1")
  })

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

  it("names an app by the label of its link before the name that the app reports", async () => {
    const { module, state } = await account(json(200, { ok: true, value: { protocol: 1, name: "vitehub-docs", operations: [], sections: [] } }))
    await module.openConsoleProject()
    expect(state.info.value?.name).toBe("vitehub-docs")
    expect(module.consoleProjectDisplayName(linked)).toBe("Docs")
    expect(module.consoleOpenProjectName("vitehub-docs")).toBe("Docs")
    const { useConsoleApp } = await import("../src/console/runtime/client/app-identity.ts")
    expect(useConsoleApp().value.name).toBe("Docs")
    // Without a label, the reported name, then the host.
    expect(module.consoleProjectDisplayName({ ...linked, label: null })).toBe("vitehub-docs")
    expect(module.consoleProjectDisplayName({ id: "p-2", label: null, url: "https://other.example.com" })).toBe("other.example.com")
  })

  it("renames an app", async () => {
    // An earlier test mocks the account module without this call.
    vi.doUnmock("../src/console/runtime/client/account.ts")
    const fetch = vi.fn(json(200, { project: { ...linked, label: "Handbook" } }))
    const { module } = await account(fetch)
    await module.renameAccountProject(linked.id, "  Handbook ")
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/projects/p-1")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(String(init.body))).toEqual({ label: "Handbook" })
    // An empty name removes the label.
    await module.renameAccountProject(linked.id, " ")
    expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ label: null })
  })

  it("keeps media links on the app while forwarding data requests", async () => {
    const { module } = await account(json(200, { ok: true, value: { protocol: 1, name: "Docs", operations: [], sections: [] } }))
    await module.openConsoleProject()
    const media = await import("../src/console/runtime/client/media-library.ts")
    const transport = await import("../src/console/runtime/client/project.ts")
    expect(media.consoleMediaUrl("/portal/images/", "photo.png")).toBe("https://app.example.com/portal/images/photo.png")
    expect(transport.projectAppUrl("/mcp")).toBe("https://app.example.com/portal/mcp")
    expect(transport.projectUrl("/_vitehub/rpc")).toBe("/p/p-1/_vitehub/rpc")
  })

  it("shows the variable to set while the project has no public key for the link, or another one, or no Console yet", async () => {
    for (const answer of [
      json(500, { code: "CONSOLE_KEY_NOT_CONFIGURED", message: "not set", ok: false, status: 500 }),
      // An app without `console: true` answers the Console route with its 404 page.
      operationRpcFetch(async () => new Response("<!doctype html><title>404</title>", { headers: { "content-type": "text/html" }, status: 404 })),
      json(401, { code: "CONSOLE_KEY_UNKNOWN", message: "unknown", ok: false, status: 401 }),
      json(401, { code: "CONSOLE_SIGNATURE_INVALID", message: "refused", ok: false, status: 401 }),
    ]) {
      const { module, state } = await account(answer)
      await module.openConsoleProject()
      expect(state.gate.value).toEqual({ kind: "setup", project: linked })
      vi.resetModules()
    }
  })

  it("keeps the problem page when the app's server fails with a page that is not JSON", async () => {
    const { module, state } = await account(operationRpcFetch(async () => new Response("<!doctype html><title>502 Bad Gateway</title>", { headers: { "content-type": "text/html" }, status: 502 })))
    await module.openConsoleProject()
    expect(state.gate.value).toMatchObject({ kind: "problem" })
  })

  it("starts with the empty state when the team has no project", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const module = await import("../src/console/runtime/client/project-session.ts")
    const state = module.startConsoleProjects({ base: "", home: "/", mode: "account", navigate: vi.fn(), pageOrigin: "https://console.example.com", storage: memoryProjectStorage() })
    expect(state.gate.value).toEqual({ kind: "empty" })
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

  it("opens the account page that the path names, such as /team-settings", async () => {
    const session = { user: { id: "u", name: "Ada", email: "ada@example.com" }, hasEmail: true, teams: [{ id: "t", name: "Personal", slug: "personal-u" }], teamId: "t", roles: ["owner"], projects: [linked] }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(session)))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const boot = { home: "/", navigate: vi.fn(), pageOrigin: "https://console.example.com", search: "", showPath: () => {} }
    await module.startConsoleAccount({ ...boot, pathname: "/team-settings" })
    expect(module.useConsoleProjects().gate.value).toEqual({ kind: "home", page: "team-settings" })
    await module.startConsoleAccount({ ...boot, pathname: "/team-settings-old" })
    expect(module.useConsoleProjects().gate.value).not.toEqual(expect.objectContaining({ kind: "home" }))
  })

  describe.each(["home", "team", "team-settings", "env", "settings"] as const)("while %s is selected", (page) => {
    it.each([200, 401])("ignores a late %s app response", async (status) => {
      const pending = pendingResponse()
      const { module, state } = await account(() => pending.promise)
      state.openingView = "shell"
      const opening = module.openConsoleProject()
      expect(state.gate.value).toEqual({ kind: "opening" })

      module.showConsoleAccountPage(page)
      pending.resolve(Response.json(status === 200 ? projectGet : signatureRejection, { status }))
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

    pending.resolve(Response.json(status === 200 ? projectGet : signatureRejection, { status }))
    await opening

    expect(state.gate.value).toEqual(status === 200 ? { kind: "ready" } : { kind: "setup", project: linked })
  })
})

describe("embedded Console", () => {
  async function embedded(fetch: (url: string, init: RequestInit) => Promise<Response>) {
    vi.stubGlobal("fetch", operationRpcFetch(fetch))
    const module = await import("../src/console/runtime/client/project-session.ts")
    const state = module.startConsoleProjects({ base: "/portal", home: "/portal/_vitehub/", mode: "embedded", navigate: () => {}, pageOrigin: "https://app.example.com", storage: memoryProjectStorage() })
    return { module, state }
  }

  it("calls its own origin without authorization and opens the app", async () => {
    const fetch = vi.fn(async () => Response.json(projectGet))
    const { module, state } = await embedded(fetch)
    await module.openConsoleProject()
    await module.consoleProjectReady()
    expect(state.gate.value).toEqual({ kind: "ready" })
    expect(state.info.value?.name).toBe("Shop")
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/portal/_vitehub/rpc")
    expect(new Headers(init.headers).has("authorization")).toBe(false)
  })

  it("opens the app when it refuses the call, so its sections show the error", async () => {
    const { module, state } = await embedded(async () => Response.json(signatureRejection, { status: 401 }))
    await module.openConsoleProject()
    expect(state.gate.value).toEqual({ kind: "ready" })
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

  it("tells when the Console shows a project on another origin", () => {
    expect(isRemoteProject()).toBe(false)
    setConsoleProject({ origin: "https://app.example.com", base: "/portal" })
    expect(isRemoteProject()).toBe(true)
  })
})
