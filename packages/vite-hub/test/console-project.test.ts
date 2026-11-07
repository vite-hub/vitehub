import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleMediaFileUrl, consoleMediaUrl } from "../src/console/runtime/client/media-library.ts"
import { consoleProject, projectFetch, projectUrl, resolveProjectUrl, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { requestConsoleOperation } from "../src/console/runtime/client/request.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"

const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true, value: [] }))
const pageProject = consoleProject()

afterEach(() => {
  setConsoleProject(pageProject)
  fetchMock.mockClear()
  vi.unstubAllGlobals()
})

describe("Console project transport", () => {
  it("sends requests to the page origin by default, as before", async () => {
    vi.stubGlobal("fetch", fetchMock)
    expect(consoleProject()).toEqual({ origin: "", base: "" })

    await requestConsoleOperation("kv.list", { store: "default" })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("/_vitehub/rpc/__call")
    expect(init?.credentials).toBe("same-origin")
    expect(init?.headers).toEqual({ "content-type": "application/json", [consoleRpcHeader]: "1" })
  })

  it("keeps the application mount of the page", async () => {
    vi.stubGlobal("fetch", fetchMock)
    setConsoleProject({ origin: "", base: "/portal" })

    await projectFetch("/_vitehub/page/session")

    expect(fetchMock.mock.calls[0]![0]).toBe("/portal/_vitehub/page/session")
    expect(projectUrl("/_vitehub/sign-in")).toBe("/portal/_vitehub/sign-in")
  })

  it("builds absolute URLs and sends the authorization of a remote project", async () => {
    vi.stubGlobal("fetch", fetchMock)
    let token = "first"
    setConsoleProject({ origin: "https://agents.example.com", base: "/portal", authorization: () => `Bearer ${token}` })

    await requestConsoleOperation("kv.list", {})
    token = "second"
    await projectFetch("/_vitehub/env/manage", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })

    const [rpcUrl, rpcInit] = fetchMock.mock.calls[0]!
    expect(rpcUrl).toBe("https://agents.example.com/portal/_vitehub/rpc/__call")
    expect(rpcInit?.headers).toMatchObject({ authorization: "Bearer first", [consoleRpcHeader]: "1" })
    // Cookies never go to another origin. The bearer token authorizes the call.
    expect(rpcInit?.credentials).toBe("same-origin")
    const [manageUrl, manageInit] = fetchMock.mock.calls[1]!
    expect(manageUrl).toBe("https://agents.example.com/portal/_vitehub/env/manage")
    expect(manageInit?.headers).toEqual({ "content-type": "application/json", authorization: "Bearer second" })
    expect(manageInit?.credentials).toBe("same-origin")
  })

  it("sends no authorization header when the project has no token", async () => {
    vi.stubGlobal("fetch", fetchMock)
    setConsoleProject({ origin: "https://agents.example.com", base: "", authorization: () => undefined })

    await projectFetch("/_vitehub/page/session", { headers: { accept: "application/json" } })

    expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({ accept: "application/json" })
  })

  it("puts the served URLs of media files on the project origin", () => {
    expect(consoleMediaUrl("/api/_vitehub/blob/", "a b.png")).toBe("/api/_vitehub/blob/a%20b.png")

    setConsoleProject({ origin: "https://agents.example.com", base: "/portal" })

    expect(consoleMediaUrl("/api/_vitehub/blob/", "a b.png")).toBe("https://agents.example.com/api/_vitehub/blob/a%20b.png")
    expect(consoleMediaFileUrl({ pathname: "a.png", url: "/files/a.png" }, null)).toBe("https://agents.example.com/files/a.png")
    expect(consoleMediaFileUrl({ pathname: "a.png", url: "https://cdn.example.com/a.png" }, null)).toBe("https://cdn.example.com/a.png")
    expect(resolveProjectUrl("//cdn.example.com/a.png")).toBe("//cdn.example.com/a.png")
  })
})
