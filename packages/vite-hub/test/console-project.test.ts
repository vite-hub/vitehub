import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleMediaFileUrl, consoleMediaUrl } from "../src/console/runtime/client/media-library.ts"
import { consoleProject, projectFetch, resolveProjectUrl, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { requestConsoleOperation } from "../src/console/runtime/client/request.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { operationRpcFetch } from "../../internal/test-utils/operation-rpc.ts"

const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true, value: [] }))
const pageProject = consoleProject()

afterEach(() => {
  setConsoleProject(pageProject)
  fetchMock.mockClear()
  vi.unstubAllGlobals()
})

describe("Console project transport", () => {
  it("sends requests to the page origin by default, as before", async () => {
    vi.stubGlobal("fetch", operationRpcFetch(fetchMock))
    expect(consoleProject()).toEqual({ origin: "", base: "" })

    await requestConsoleOperation("kv.list", { store: "default" })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("/_vitehub/rpc")
    expect(init?.credentials).toBe("same-origin")
    expect(init?.headers).toEqual({ "content-type": "application/json", [consoleRpcHeader]: "1" })
  })

  it("keeps the application mount of the page", async () => {
    vi.stubGlobal("fetch", operationRpcFetch(fetchMock))
    setConsoleProject({ origin: "", base: "/portal" })

    await projectFetch("/_vitehub/rpc", { method: "POST", body: "{}" })

    expect(fetchMock.mock.calls[0]![0]).toBe("/portal/_vitehub/rpc")
  })

  it("builds absolute URLs of a remote project and sends no authorization header", async () => {
    vi.stubGlobal("fetch", operationRpcFetch(fetchMock))
    setConsoleProject({ origin: "https://agents.example.com", base: "/portal" })

    await requestConsoleOperation("kv.list", {})

    const [rpcUrl, rpcInit] = fetchMock.mock.calls[0]!
    expect(rpcUrl).toBe("https://agents.example.com/portal/_vitehub/rpc")
    expect(rpcInit?.headers).toEqual({ "content-type": "application/json", [consoleRpcHeader]: "1" })
    // Cookies never go to another origin.
    expect(rpcInit?.credentials).toBe("same-origin")
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
