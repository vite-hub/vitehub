import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Better Auth's real Vue client. Only the network and the browser are stand-ins.
const { createAuthClient, setSessionSeedResolver, useUserSession } = await import("../src/vue.ts")

const ada = { session: { id: "s", userId: "u", expiresAt: "2999-01-01T00:00:00.000Z" }, user: { id: "u", name: "Ada" } }

/** A server whose answers the test releases. It records the path of every request. */
function createServer() {
  const requests: string[] = []
  const sessionAnswers: Array<(body: unknown) => void> = []
  let session: unknown = null
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname.replace("/api/auth", "")
    requests.push(path)
    const answer = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    if (path === "/sign-out") {
      session = null
      return answer({ success: true })
    }
    if (path === "/sign-in/email") {
      session = ada
      return answer({ redirect: false, token: "t", user: ada.user })
    }
    // A session read waits until the test releases it, unless the test lets the server answer at once.
    if (!server.holdReads) return answer(session)
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      sessionAnswers.push(body => resolve(answer(body)))
    })
  })
  const server = {
    fetch,
    requests,
    holdReads: false,
    signIn: () => { session = ada },
    /** Answers the oldest read in flight with `body`. */
    answerRead: (body: unknown) => sessionAnswers.shift()?.(body),
    sessionReads: () => requests.filter(path => path === "/get-session").length,
  }
  return server
}

const options = (server: ReturnType<typeof createServer>) => ({ baseURL: "http://localhost:3000", fetchOptions: { customFetchImpl: server.fetch as typeof fetch } })

/** Lets Better Auth's timers, such as its 10 ms session signal, and its reads run. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick++) await new Promise(resolve => setTimeout(resolve, 15))
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget())
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }))
  vi.stubGlobal("localStorage", { setItem: () => {}, getItem: () => null, removeItem: () => {} })
})

afterEach(() => {
  setSessionSeedResolver(undefined)
  vi.unstubAllGlobals()
})

describe("a session read that started before signOut()", () => {
  it.each([
    ["with Better Auth's session signal", undefined],
    ["without it", { disableSignal: true }],
  ])("cannot show the user again (%s)", async (_name, fetchOptions) => {
    const server = createServer()
    server.signIn()
    setSessionSeedResolver(() => ada)
    const session = useUserSession(createAuthClient(options(server)))
    server.holdReads = true
    const before = session.refresh()
    await vi.waitFor(() => expect(server.sessionReads()).toBe(1))

    await session.signOut(undefined, fetchOptions)
    expect(session.user.value).toBeNull()
    // The server answers the old read after the sign-out, with the session from before it.
    server.answerRead(ada)

    await expect(before).resolves.toBeNull()
    await settle()
    expect(session.user.value).toBeNull()
    expect(session.loggedIn.value).toBe(false)
  })

  it("is not the answer of a read after the sign-out, such as the page guard's", async () => {
    const server = createServer()
    server.signIn()
    setSessionSeedResolver(() => ada)
    const session = useUserSession(createAuthClient(options(server)))
    server.holdReads = true
    const before = session.refresh()
    await vi.waitFor(() => expect(server.sessionReads()).toBe(1))

    await session.signOut(undefined, { disableSignal: true })
    const after = session.refresh()
    await vi.waitFor(() => expect(server.sessionReads()).toBe(2))
    server.answerRead(ada)
    server.answerRead(null)

    await expect(after).resolves.toBeNull()
    await expect(before).resolves.toBeNull()
    expect(session.user.value).toBeNull()
  })
})
