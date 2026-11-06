import { afterEach, describe, expect, it, vi } from "vitest"

import {
  consoleLinkVerifier,
  consolePendingLinkLifetime,
  consolePendingLinksStorageKey,
  createConsolePendingLinkStore,
  parseConsoleLinkFragment,
  takeConsoleLinkHash,
} from "../src/console/runtime/client/pending-links.ts"
import { consoleProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { createConsoleProjectStore, memoryProjectStorage } from "../src/console/runtime/client/projects.ts"

const pageProject = consoleProject()
afterEach(() => {
  setConsoleProject(pageProject)
  vi.unstubAllGlobals()
  vi.resetModules()
})

const projectGet = { ok: true, value: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv"], operations: ["kv.list"] } }
const tokenRejection = { code: "CONSOLE_TOKEN_INVALID", message: "The Console token is not correct.", ok: false, status: 401 }
const app = { origin: "https://app.example.com", base: "", url: "https://app.example.com" }

// Shared by independent sessions, like the browser's origin-wide Web Locks manager.
function linkLocks() {
  let tail = Promise.resolve()
  return {
    request<T>(_name: string, run: () => Promise<T>): Promise<T> {
      const result = tail.then(run)
      tail = result.then(() => {}, () => {})
      return result
    },
  }
}

describe("pending link verifier", () => {
  it("is the hex SHA-256 that `printf %s \"$secret\" | sha256sum` prints", async () => {
    // printf %s "dGhpcy1pcy1hLWZpeGVkLXRlc3Qtc2VjcmV0LTMyYnl0ZXM" | sha256sum
    expect(await consoleLinkVerifier("dGhpcy1pcy1hLWZpeGVkLXRlc3Qtc2VjcmV0LTMyYnl0ZXM"))
      .toBe("0cab84cb77b65b58037b6ce581c0c53fc8af18d360941e8cf1834920965764c1")
  })
})

describe("pending link store", () => {
  it("keeps a 32-byte base64url secret and gives out only the id and the verifier", async () => {
    const storage = memoryProjectStorage()
    const store = createConsolePendingLinkStore(storage, { now: () => 1_000 })
    const ticket = await store.create()

    expect(Object.keys(ticket).sort()).toEqual(["pendingId", "verifier"])
    expect(ticket.pendingId).toMatch(/^[\w-]{16}$/)
    expect(ticket.verifier).toMatch(/^[\da-f]{64}$/)
    const lookup = store.lookup(ticket.pendingId)
    if (lookup.kind !== "pending") throw new Error("Expected a pending link")
    expect(lookup.link).toEqual({ pendingId: ticket.pendingId, secret: expect.stringMatching(/^[\w-]{43}$/), createdAt: 1_000 })
    expect(Buffer.from(lookup.link.secret, "base64url")).toHaveLength(32)
    expect(await consoleLinkVerifier(lookup.link.secret)).toBe(ticket.verifier)
    expect(lookup.link.secret).not.toContain(ticket.pendingId)

    const second = await store.create()
    expect(second.pendingId).not.toBe(ticket.pendingId)
    expect(second.verifier).not.toBe(ticket.verifier)
    expect(JSON.parse(storage.getItem(consolePendingLinksStorageKey) ?? "")).toHaveLength(2)
  })

  it("expires a link after 24 hours and sweeps it on read", async () => {
    let now = 0
    const storage = memoryProjectStorage()
    const store = createConsolePendingLinkStore(storage, { now: () => now })
    const old = await store.create()
    now = consolePendingLinkLifetime - 1
    const fresh = await store.create()
    expect(store.lookup(old.pendingId).kind).toBe("pending")

    now = consolePendingLinkLifetime + 1
    expect(store.lookup(old.pendingId)).toEqual({ kind: "expired" })
    // The read removed it, so the next read does not know it.
    expect(store.lookup(old.pendingId)).toEqual({ kind: "unknown" })
    expect(store.lookup(fresh.pendingId).kind).toBe("pending")
    expect(JSON.parse(storage.getItem(consolePendingLinksStorageKey) ?? "").map((link: { pendingId: string }) => link.pendingId)).toEqual([fresh.pendingId])
  })

  it("drops stored entries that are not pending links", () => {
    const storage = memoryProjectStorage()
    storage.setItem(consolePendingLinksStorageKey, JSON.stringify([
      { pendingId: "abcdefgh", secret: "s", createdAt: 5 },
      { pendingId: "abcdefgh", secret: "other", createdAt: 5 },
      { pendingId: "no spaces", secret: "s", createdAt: 5 },
      { pendingId: "ijklmnop", secret: "", createdAt: 5 },
      { pendingId: "qrstuvwx", secret: "s", createdAt: "5" },
      "text",
    ]))
    const store = createConsolePendingLinkStore(storage, { now: () => 10 })
    expect(store.lookup("abcdefgh")).toEqual({ kind: "pending", link: { pendingId: "abcdefgh", secret: "s", createdAt: 5 } })
    expect(store.lookup("qrstuvwx")).toEqual({ kind: "unknown" })
    storage.setItem(consolePendingLinksStorageKey, "{not json")
    expect(store.lookup("abcdefgh")).toEqual({ kind: "unknown" })
  })
})

describe("/link fragment", () => {
  it.each([
    ["#p=abcdefgh12345678&url=https%3A%2F%2Fapp.example.com", "https://app.example.com", ""],
    ["#p=abcdefgh12345678&url=https://app.example.com/", "https://app.example.com", ""],
    ["p=abcdefgh12345678&url=https://app.example.com/portal", "https://app.example.com", "/portal"],
    ["#p=abcdefgh12345678&url=http://127.0.0.1:4100", "http://127.0.0.1:4100", ""],
    ["#p=abcdefgh12345678&url=http://localhost:5173", "http://localhost:5173", ""],
  ])("reads %s", (hash, origin, base) => {
    expect(parseConsoleLinkFragment(hash)).toEqual({ kind: "confirm", pendingId: "abcdefgh12345678", target: { origin, base, url: `${origin}${base}` } })
  })

  it.each([
    ["", "This link is not complete"],
    ["#url=https://app.example.com", "This link is not complete"],
    ["#p=abcdefgh12345678", "This link is not complete"],
    ["#p=bad id&url=https://app.example.com", "This link is not valid"],
    ["#p=abcdefgh12345678&url=http://app.example.com", "Use HTTPS"],
    ["#p=abcdefgh12345678&url=ftp://app.example.com", "Check the app URL"],
    ["#p=abcdefgh12345678&url=https://user:pass@app.example.com", "Check the app URL"],
  ])("rejects %j", (hash, title) => {
    expect(parseConsoleLinkFragment(hash)).toMatchObject({ kind: "problem", problem: { title } })
  })

  it("takes the fragment of /link and removes it from the address bar", () => {
    const replaceState = vi.fn()
    const page = (pathname: string, hash: string) => ({ history: { replaceState, state: { position: 3 } }, location: { hash, pathname, search: "?a=1" } })

    expect(takeConsoleLinkHash(page("/link", "#p=abcdefgh&url=https://app.example.com"), "/")).toBe("#p=abcdefgh&url=https://app.example.com")
    expect(replaceState).toHaveBeenCalledWith({ position: 3 }, "", "/link?a=1")

    replaceState.mockClear()
    expect(takeConsoleLinkHash(page("/console/link/", "#p=x"), "/console/")).toBe("#p=x")
    expect(takeConsoleLinkHash(page("/kv", "#p=x"), "/")).toBeUndefined()
    expect(takeConsoleLinkHash(page("/link", ""), "/")).toBe("")
    expect(replaceState).toHaveBeenCalledTimes(1)
  })
})

describe("linking from a pending link", () => {
  async function session(fetch: (url: string, init: RequestInit) => Promise<Response>) {
    const fetchMock = vi.fn(fetch)
    vi.stubGlobal("fetch", fetchMock)
    const module = await import("../src/console/runtime/client/project-session.ts")
    const navigate = vi.fn()
    const storage = memoryProjectStorage()
    const pendingLinkLocks = linkLocks()
    const state = module.startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate, pageOrigin: "https://console.example.com", storage, pendingLinkLocks })
    const ticket = await module.createConsolePendingLink()
    return { fetch: fetchMock, module, navigate, state, storage, ticket, pendingLinkLocks }
  }

  it("does not disclose one secret to two projects during concurrent confirmations in separate tabs", async () => {
    let finish!: (response: Response) => void
    const response = new Promise<Response>(resolve => { finish = resolve })
    const { fetch, module, storage, ticket, pendingLinkLocks } = await session(async () => (await response).clone())
    vi.resetModules()
    const otherTab = await import("../src/console/runtime/client/project-session.ts")
    otherTab.startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate: vi.fn(), pageOrigin: "https://console.example.com", storage, pendingLinkLocks })

    const first = module.confirmConsoleLink(ticket.pendingId, app)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const second = otherTab.confirmConsoleLink(ticket.pendingId, { origin: "https://other.example.com", base: "", url: "https://other.example.com" })
    finish(Response.json(projectGet))

    expect(await first).toMatchObject({ kind: "linked" })
    const secondResult = await second
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(secondResult).toMatchObject({ kind: "problem", final: true })
  })

  it("keeps a failed link bound to its first confirmed project across tabs, and permits retrying that project", async () => {
    const { fetch, module, storage, ticket, pendingLinkLocks } = await session(async () => Response.json(tokenRejection, { status: 401 }))
    expect(await module.confirmConsoleLink(ticket.pendingId, app)).toMatchObject({ kind: "problem", final: false })
    vi.resetModules()
    const otherTab = await import("../src/console/runtime/client/project-session.ts")
    otherTab.startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate: vi.fn(), pageOrigin: "https://console.example.com", storage, pendingLinkLocks })
    expect(await otherTab.confirmConsoleLink(ticket.pendingId, { ...app, base: "/other", url: `${app.url}/other` }))
      .toMatchObject({ kind: "problem", final: true, problem: { title: "This link belongs to another project" } })
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockResolvedValue(Response.json(projectGet))
    expect(await otherTab.confirmConsoleLink(ticket.pendingId, app)).toMatchObject({ kind: "linked" })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("sends nothing when the browser cannot lock confirmations across tabs", async () => {
    const { fetch, module, storage, ticket } = await session(async () => Response.json(projectGet))
    module.startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate: vi.fn(), pageOrigin: "https://console.example.com", storage })
    expect(await module.confirmConsoleLink(ticket.pendingId, app)).toMatchObject({ kind: "problem", final: false, problem: { title: "Update your browser" } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("asks first, then links with the secret as the token, and works only once", async () => {
    let secret = ""
    const { fetch, module, state, ticket } = await session(async (_url, init) =>
      new Headers(init.headers).get("authorization") === `Bearer ${secret}` ? Response.json(projectGet) : Response.json(tokenRejection, { status: 401 }))
    const pending = state.pendingLinks.lookup(ticket.pendingId)
    if (pending.kind !== "pending") throw new Error("Expected a pending link")
    secret = pending.link.secret

    const request = module.startConsoleLink(`#p=${ticket.pendingId}&url=https://app.example.com`)
    expect(request).toEqual({ kind: "confirm", pendingId: ticket.pendingId, target: app })
    expect(state.gate.value).toEqual({ kind: "link", request })
    // Nothing goes to the app before the person confirms it.
    expect(fetch).not.toHaveBeenCalled()

    const linked = await module.confirmConsoleLink(ticket.pendingId, app)
    expect(linked).toMatchObject({ kind: "linked", project: { url: "https://app.example.com", label: "Shop", token: secret } })
    expect(state.store.active()?.token).toBe(secret)
    expect(state.pendingLinks.lookup(ticket.pendingId)).toEqual({ kind: "unknown" })

    const unknown = {
      title: "This link cannot be used here",
      message: "This link was made in another browser or already used. Open the Console where you started the project, or relink.",
    }
    expect(module.startConsoleLink(`#p=${ticket.pendingId}&url=https://app.example.com`)).toEqual({ kind: "problem", problem: unknown })
    expect(await module.confirmConsoleLink(ticket.pendingId, app)).toEqual({ kind: "problem", problem: unknown, final: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("keeps the link when the host secret does not match or the app is unreachable", async () => {
    let reachable = true
    const { module, state, ticket } = await session(async () => {
      if (!reachable) throw new TypeError("Failed to fetch")
      return Response.json(tokenRejection, { status: 401 })
    })

    const mismatch = await module.confirmConsoleLink(ticket.pendingId, app)
    expect(mismatch).toMatchObject({ kind: "problem", final: false, problem: { title: "The host secret does not match" } })
    if (mismatch.kind !== "problem") throw new Error("Expected a problem")
    expect(mismatch.problem.message).toContain("Run the command again or relink.")

    reachable = false
    expect(await module.confirmConsoleLink(ticket.pendingId, app)).toEqual({
      kind: "problem",
      final: false,
      problem: { title: "Cannot reach app.example.com", message: "https://console.example.com is not in console.origins for app.example.com. Add it and redeploy. The project may also be offline." },
    })
    expect(state.pendingLinks.lookup(ticket.pendingId).kind).toBe("pending")
    expect(state.store.list()).toEqual([])
  })

  it("refuses an expired link before it sends anything", async () => {
    const { fetch, module, storage, ticket } = await session(async () => Response.json(projectGet))
    const [link] = JSON.parse(storage.getItem(consolePendingLinksStorageKey) ?? "")
    storage.setItem(consolePendingLinksStorageKey, JSON.stringify([{ ...link, createdAt: Date.now() - consolePendingLinkLifetime - 1 }]))

    expect(module.startConsoleLink(`#p=${ticket.pendingId}&url=https://app.example.com`)).toMatchObject({ kind: "problem", problem: { title: "This link expired" } })
    expect(await module.confirmConsoleLink(ticket.pendingId, app)).toMatchObject({ kind: "problem", final: true, problem: { title: "This link cannot be used here" } })
    expect(fetch).not.toHaveBeenCalled()
    expect(createConsoleProjectStore(storage).list()).toEqual([])
  })
})
