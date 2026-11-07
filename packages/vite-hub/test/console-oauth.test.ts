import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleOAuthClientDocument, resolveConsoleHostedOrigin } from "../src/console/hosted/oauth-client.ts"
import {
  consoleAuthorizationServerMetadataUrl,
  consoleCodeChallenge,
  consoleOAuthStateLifetime,
  consoleOAuthStateStorageKey,
  createConsoleCodeVerifier,
  createConsoleOAuthRefresher,
  createConsoleOAuthStateStore,
  storageOAuthLock,
  discoverConsoleOAuth,
  loadConsoleOAuthClient,
  parseConsoleOAuthCallback,
  takeConsoleOAuthCallback,
} from "../src/console/runtime/client/oauth.ts"
import { consoleProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { consoleProjectsStorageKey, createConsoleProjectStore, memoryProjectStorage, openConsoleStorage } from "../src/console/runtime/client/projects.ts"

import type { ConsoleOAuthLock, ConsoleOAuthFetch, ConsoleOAuthPendingSignIn, ConsoleOAuthTokens } from "../src/console/runtime/client/oauth.ts"

const pageProject = consoleProject()
afterEach(() => {
  setConsoleProject(pageProject)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

const consoleOrigin = "https://console.example.com"
const app = { origin: "https://app.example.com", base: "", url: "https://app.example.com" }
const issuer = "https://app.example.com/api/auth"
const resourceMetadata = "https://app.example.com/.well-known/oauth-protected-resource/_vitehub"
const challenge = `Bearer realm="vitehub-console", resource_metadata="${resourceMetadata}"`

function tokens(overrides: Partial<ConsoleOAuthTokens> = {}): ConsoleOAuthTokens {
  return {
    accessToken: "access-1",
    clientId: `${consoleOrigin}/oauth-client.json`,
    expiresAt: 10_000_000,
    issuer,
    refreshToken: "refresh-1",
    resource: "https://app.example.com/_vitehub",
    revocationEndpoint: `${issuer}/oauth2/revoke`,
    tokenEndpoint: `${issuer}/oauth2/token`,
    ...overrides,
  }
}

function pending(overrides: Partial<ConsoleOAuthPendingSignIn> = {}): ConsoleOAuthPendingSignIn {
  return {
    clientId: `${consoleOrigin}/oauth-client.json`,
    createdAt: 0,
    issuer,
    issuerInResponse: false,
    projectUrl: app.url,
    redirectUri: `${consoleOrigin}/oauth/callback`,
    resource: "https://app.example.com/_vitehub",
    state: "state-1",
    tokenEndpoint: `${issuer}/oauth2/token`,
    verifier: "v".repeat(43),
    ...overrides,
  }
}

interface Call { url: string, method: string, body: URLSearchParams, authorization?: string }

/**
 * An app with `auth: "app"` and `consoleMcpOAuth()`: the Console RPC, the OAuth metadata, the token and revocation
 * endpoints, and the client document of the Console. Each refresh rotates the refresh token.
 */
function fakeApp(options: { expiresIn?: number, issuerInResponse?: boolean, refreshTokens?: string[], tokenDelay?: Promise<void> } = {}) {
  const calls: Call[] = []
  let issued = 0
  const access = new Set<string>()
  const refresh = new Set<string>(options.refreshTokens)
  const codes = new Map<string, string>()
  const issue = () => {
    issued += 1
    access.add(`access-${issued}`)
    refresh.add(`refresh-${issued}`)
    return Response.json({ access_token: `access-${issued}`, expires_in: options.expiresIn ?? 900, refresh_token: `refresh-${issued}`, scope: "offline_access vitehub:read vitehub:write", token_type: "Bearer" })
  }
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    const headers = new Headers(init.headers)
    const body = new URLSearchParams(String(init.body ?? ""))
    calls.push({ url, method: init.method ?? "GET", body, ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}) })
    if (url === `${consoleOrigin}/oauth-client.json`) return Response.json(consoleOAuthClientDocument(consoleOrigin))
    if (url === resourceMetadata) return Response.json({ authorization_servers: [issuer], resource: "https://app.example.com/_vitehub", scopes_supported: ["vitehub:read", "vitehub:write", "offline_access"] })
    if (url === "https://app.example.com/.well-known/oauth-authorization-server/api/auth") {
      return Response.json({
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        ...(options.issuerInResponse ? { authorization_response_iss_parameter_supported: true } : {}),
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ["S256"],
        issuer,
        revocation_endpoint: `${issuer}/oauth2/revoke`,
        token_endpoint: `${issuer}/oauth2/token`,
      })
    }
    if (url === `${issuer}/oauth2/token`) {
      await options.tokenDelay
      if (body.get("grant_type") === "authorization_code") {
        const verifier = codes.get(body.get("code") ?? "")
        if (!verifier || await consoleCodeChallenge(body.get("code_verifier") ?? "") !== verifier) return Response.json({ error: "invalid_grant", error_description: "code verification failed" }, { status: 400 })
        codes.delete(body.get("code")!)
        return issue()
      }
      const presented = body.get("refresh_token") ?? ""
      if (!refresh.delete(presented)) return Response.json({ error: "invalid_grant", error_description: "invalid refresh token" }, { status: 400 })
      return issue()
    }
    if (url === `${issuer}/oauth2/revoke`) {
      refresh.delete(body.get("token") ?? "")
      return new Response(null, { status: 200 })
    }
    if (url === "https://app.example.com/_vitehub/rpc/__call") {
      const token = headers.get("authorization")?.replace(/^Bearer /, "")
      if (!token) return Response.json({ code: "CONSOLE_SIGN_IN_REQUIRED", ok: false, status: 401 }, { headers: { "www-authenticate": challenge }, status: 401 })
      if (!access.has(token)) return Response.json({ code: "CONSOLE_SIGN_IN_REQUIRED", ok: false, status: 401 }, { headers: { "www-authenticate": `Bearer realm="vitehub-console", error="invalid_token", resource_metadata="${resourceMetadata}"` }, status: 401 })
      return Response.json({ ok: true, value: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv"], operations: ["kv.list"] } })
    }
    return new Response("Not found", { status: 404 })
  })
  return {
    calls,
    fetch,
    /** What the authorization endpoint does after consent: remember the challenge and give out a code. */
    authorize(authorizationUrl: string): string {
      const url = new URL(authorizationUrl)
      const code = `code-${codes.size + 1}`
      codes.set(code, url.searchParams.get("code_challenge")!)
      return code
    },
    expire(token: string) {
      access.delete(token)
    },
    hasRefreshToken: (token: string) => refresh.has(token),
  }
}

describe("hosted OAuth client document", () => {
  it("names its own URL as client_id and one callback on the same origin", () => {
    expect(consoleOAuthClientDocument("https://console.vitehub.dev")).toEqual({
      client_id: "https://console.vitehub.dev/oauth-client.json",
      client_name: "ViteHub Console",
      redirect_uris: ["https://console.vitehub.dev/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "vitehub:read vitehub:write offline_access",
    })
  })

  it("builds for console.vitehub.dev by default and for an https origin from VITEHUB_CONSOLE_ORIGIN", () => {
    expect(resolveConsoleHostedOrigin(undefined)).toBe("https://console.vitehub.dev")
    expect(resolveConsoleHostedOrigin(" https://Console.Example.com/ ")).toBe("https://console.example.com")
    expect(() => resolveConsoleHostedOrigin("http://console.example.com")).toThrow("must be an https:// origin")
    expect(() => resolveConsoleHostedOrigin("https://example.com/console")).toThrow("with no path")
    expect(() => resolveConsoleHostedOrigin("console.example.com")).toThrow("is not a URL")
  })
})

describe("PKCE", () => {
  it("makes a 43-character verifier from the unreserved set", () => {
    const verifiers = new Set(Array.from({ length: 20 }, createConsoleCodeVerifier))
    expect(verifiers.size).toBe(20)
    for (const verifier of verifiers) expect(verifier).toMatch(/^[\w-]{43}$/)
  })

  it("computes the S256 challenge of the RFC 7636 appendix B vector", async () => {
    expect(await consoleCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })
})

describe("sign-in state", () => {
  it("finds a state once", () => {
    const storage = memoryProjectStorage()
    const store = createConsoleOAuthStateStore(storage, { now: () => 1_000 })
    store.save(pending({ createdAt: 1_000 }))
    expect(store.take("state-1")).toEqual({ kind: "pending", signIn: pending({ createdAt: 1_000 }) })
    expect(store.take("state-1")).toEqual({ kind: "unknown" })
    expect(store.take("other")).toEqual({ kind: "unknown" })
    expect(JSON.parse(storage.getItem(consoleOAuthStateStorageKey) ?? "")).toEqual([])
  })

  it("expires a sign-in after 10 minutes", () => {
    let now = 0
    const store = createConsoleOAuthStateStore(memoryProjectStorage(), { now: () => now })
    store.save(pending({ state: "a" }))
    store.save(pending({ state: "b" }))
    now = consoleOAuthStateLifetime
    expect(store.take("a").kind).toBe("pending")
    now = consoleOAuthStateLifetime + 1
    expect(store.take("b")).toEqual({ kind: "expired", signIn: pending({ state: "b" }) })
  })

  it("ignores stored entries that are not sign-ins", () => {
    const storage = memoryProjectStorage()
    storage.setItem(consoleOAuthStateStorageKey, JSON.stringify([{ state: "a" }, "text", pending({ state: "b", verifier: "" })]))
    const store = createConsoleOAuthStateStore(storage, { now: () => 0 })
    expect(store.take("a")).toEqual({ kind: "unknown" })
    expect(store.take("b")).toEqual({ kind: "unknown" })
  })
})

describe("callback", () => {
  it.each([
    ["?code=abc&state=s1&iss=https%3A%2F%2Fapp.example.com%2Fapi%2Fauth", { kind: "code", code: "abc", state: "s1", issuer }],
    ["?code=abc&state=s1", { kind: "code", code: "abc", state: "s1" }],
    ["?error=access_denied&state=s1", { kind: "error", error: "access_denied", state: "s1" }],
    ["?error=access_denied&state=s1&iss=https%3A%2F%2Fevil.example.com", { kind: "error", error: "access_denied", state: "s1", issuer: "https://evil.example.com" }],
    ["?error=invalid_scope&error_description=Unknown+scope", { kind: "error", error: "invalid_scope", description: "Unknown scope" }],
    ["?code=abc", { kind: "invalid" }],
    ["", { kind: "invalid" }],
  ])("reads %s", (search, expected) => {
    expect(parseConsoleOAuthCallback(search)).toEqual(expected)
  })

  it("takes the query of /oauth/callback and replaces the address with the Console home", () => {
    const replaceState = vi.fn()
    const page = (pathname: string) => ({ history: { replaceState, state: null }, location: { hash: "", pathname, search: "?code=abc&state=s1" } })
    expect(takeConsoleOAuthCallback(page("/kv"), "/")).toBeUndefined()
    expect(replaceState).not.toHaveBeenCalled()
    expect(takeConsoleOAuthCallback(page("/oauth/callback"), "/")).toBe("?code=abc&state=s1")
    expect(replaceState).toHaveBeenCalledWith(null, "", "/")
  })
})

describe("discovery", () => {
  it("reads the protected resource and its authorization server", async () => {
    const { fetch } = fakeApp()
    expect(consoleAuthorizationServerMetadataUrl(issuer)).toBe("https://app.example.com/.well-known/oauth-authorization-server/api/auth")
    expect(await discoverConsoleOAuth(app, resourceMetadata, { consoleOrigin, fetch })).toEqual({
      discovery: {
        authorizationEndpoint: `${issuer}/oauth2/authorize`,
        issuer,
        issuerInResponse: false,
        resource: "https://app.example.com/_vitehub",
        revocationEndpoint: `${issuer}/oauth2/revoke`,
        tokenEndpoint: `${issuer}/oauth2/token`,
      },
    })
  })

  it.each([
    ["a resource of another app", { resource: "https://other.example.com/_vitehub", authorization_servers: [issuer] }, undefined, "names another resource"],
    ["no authorization server", { resource: "https://app.example.com/_vitehub", authorization_servers: [] }, undefined, "names no sign-in server"],
    ["no PKCE S256", undefined, { code_challenge_methods_supported: ["plain"] }, "does not support PKCE"],
    ["no client ID Metadata Documents", undefined, { client_id_metadata_document_supported: false }, "cannot sign this Console in"],
    ["another issuer", undefined, { issuer: "https://evil.example.com" }, "does not match"],
  ])("refuses %s", async (_name, resource, server, title) => {
    const base = fakeApp().fetch
    const fetch = async (input: string, init?: RequestInit) => {
      if (input === resourceMetadata && resource) return Response.json(resource)
      const response = await base(input, init)
      if (!server || !input.includes("oauth-authorization-server")) return response
      const document: unknown = await response.json()
      return Response.json(Object.assign({}, document, server))
    }
    const result = await discoverConsoleOAuth(app, resourceMetadata, { consoleOrigin, fetch })
    expect("problem" in result && result.problem.title).toContain(title)
  })

  it("checks that the client document names this Console origin", async () => {
    const { fetch } = fakeApp()
    expect(await loadConsoleOAuthClient(consoleOrigin, fetch)).toEqual({ client: { clientId: `${consoleOrigin}/oauth-client.json`, redirectUri: `${consoleOrigin}/oauth/callback` } })
    const built = async () => Response.json(consoleOAuthClientDocument("https://console.vitehub.dev"))
    const other = await loadConsoleOAuthClient(consoleOrigin, built)
    expect("problem" in other && other.problem.message).toBe("Its client document names https://console.vitehub.dev, but this page runs on https://console.example.com. Build the Console again with `VITEHUB_CONSOLE_ORIGIN=https://console.example.com`.")
    const missing = await loadConsoleOAuthClient(consoleOrigin, async () => new Response("Not found", { status: 404 }))
    expect("problem" in missing && missing.problem.title).toBe("This Console cannot sign in with OAuth")
  })
})

describe("refresh", () => {
  function refresher(app: { fetch: ConsoleOAuthFetch }, initial: ConsoleOAuthTokens | undefined, now = () => 0) {
    let stored = initial
    const writes: (ConsoleOAuthTokens | null)[] = []
    const instance = createConsoleOAuthRefresher({
      fetch: app.fetch,
      now,
      read: () => stored,
      write: (_url, next) => {
        writes.push(next)
        stored = next ?? undefined
      },
    })
    return { instance, writes, stored: () => stored }
  }

  it("sends a token that is still valid without a refresh", async () => {
    const server = fakeApp()
    const { instance } = refresher(server, tokens({ expiresAt: 61_001 }))
    expect(await instance.accessToken(app.url)).toBe("access-1")
    expect(server.fetch).not.toHaveBeenCalled()
  })

  it("refreshes once for concurrent requests when the token expires within a minute", async () => {
    let release!: () => void
    const server = fakeApp({ refreshTokens: ["refresh-0"], tokenDelay: new Promise<void>((resolve) => { release = resolve }) })
    const { instance, stored } = refresher(server, tokens({ expiresAt: 60_000, refreshToken: "refresh-0" }))

    const requests = [instance.accessToken(app.url), instance.accessToken(app.url), instance.accessToken(app.url)]
    release()
    expect(await Promise.all(requests)).toEqual(["access-1", "access-1", "access-1"])
    expect(server.calls.filter(call => call.url.endsWith("/oauth2/token"))).toHaveLength(1)
    expect(stored()).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" })
  })

  it("removes the tokens when the server refuses the refresh token", async () => {
    const server = fakeApp()
    const { instance, stored, writes } = refresher(server, tokens({ expiresAt: 0, refreshToken: "revoked" }))
    expect(await Promise.all([instance.accessToken(app.url), instance.accessToken(app.url)])).toEqual([undefined, undefined])
    expect(server.calls).toHaveLength(1)
    expect(writes).toEqual([null])
    expect(stored()).toBeUndefined()
  })

  it.each(["tokens", "invalid_grant", "temporarily_unavailable"])("preserves a newer sign-in when an old refresh returns %s", async (answer) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    let stored: ConsoleOAuthTokens | undefined = tokens({ expiresAt: 0 })
    const newer = tokens({ accessToken: "new-sign-in", refreshToken: "new-grant" })
    const writes = vi.fn()
    const instance = createConsoleOAuthRefresher({
      fetch: async () => {
        await pending
        return answer === "tokens"
          ? Response.json({ access_token: "old-refresh", refresh_token: "old-grant", token_type: "Bearer", expires_in: 900 })
          : Response.json({ error: answer }, { status: 400 })
      },
      now: () => 0,
      read: () => stored,
      write: writes,
    })
    const refresh = instance.accessToken(app.url)
    stored = newer
    release()
    expect(await refresh).toBe("new-sign-in")
    expect(writes).not.toHaveBeenCalled()
    expect(stored).toEqual(newer)
  })

  it("rotates the refresh token and keeps the new tokens", async () => {
    const server = fakeApp()
    const signIn = pending()
    const code = server.authorize(`${issuer}/oauth2/authorize?code_challenge=${await consoleCodeChallenge(signIn.verifier)}`)
    const { exchangeConsoleOAuthCode } = await import("../src/console/runtime/client/oauth.ts")
    const exchanged = await exchangeConsoleOAuthCode(signIn, code, { fetch: server.fetch, now: () => 0 })
    if (exchanged.kind !== "tokens") throw new Error("Expected tokens")
    expect(exchanged.tokens).toMatchObject({ accessToken: "access-1", expiresAt: 900_000, refreshToken: "refresh-1" })

    let now = 900_000 - 30_000
    const { instance, stored } = refresher(server, exchanged.tokens, () => now)
    const answers = await Promise.all([instance.accessToken(app.url), instance.accessToken(app.url)])
    expect(answers).toEqual(["access-2", "access-2"])
    expect(stored()).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", expiresAt: now + 900_000 })
    expect(server.hasRefreshToken("refresh-1")).toBe(false)
    const refreshes = server.calls.filter(call => call.body.get("grant_type") === "refresh_token")
    expect(refreshes).toHaveLength(1)
    expect(Object.fromEntries(refreshes[0]!.body)).toEqual({ client_id: signIn.clientId, grant_type: "refresh_token", refresh_token: "refresh-1", resource: signIn.resource })

    // A token that the project refused refreshes even when it has not expired.
    now = 0
    expect(await instance.accessToken(app.url, { rejected: "access-2" })).toBe("access-3")
  })

  it("keeps the tokens when the token endpoint cannot be reached", async () => {
    const offline = { fetch: vi.fn(async () => { throw new TypeError("Failed to fetch") }) }
    const { instance, stored } = refresher(offline as unknown as ReturnType<typeof fakeApp>, tokens({ expiresAt: 0 }))
    expect(await instance.accessToken(app.url)).toBe("access-1")
    expect(await instance.accessToken(app.url, { rejected: "access-1" })).toBeUndefined()
    expect(stored()).toEqual(tokens({ expiresAt: 0 }))
  })

  it.each([
    { status: 408, error: undefined },
    { status: 429, error: undefined },
    { status: 500, error: undefined },
    { status: 503, error: undefined },
    { status: 400, error: "server_error" },
    { status: 400, error: "temporarily_unavailable" },
  ])("keeps tokens after a temporary refresh failure ($status, $error) and retries later", async ({ status, error }) => {
    const temporary = async () => error ? Response.json({ error }, { status }) : new Response("Try later", { status })
    const fetch = vi.fn<ConsoleOAuthFetch>()
      .mockImplementationOnce(temporary)
      .mockImplementationOnce(temporary)
      .mockResolvedValueOnce(Response.json({ access_token: "recovered", refresh_token: "rotated", token_type: "Bearer", expires_in: 900 }))
    const initial = tokens({ expiresAt: 30_000 })
    const { instance, stored, writes } = refresher({ fetch }, initial)
    expect(await instance.accessToken(app.url)).toBe("access-1")
    expect(await instance.accessToken(app.url, { rejected: "access-1" })).toBeUndefined()
    expect(stored()).toEqual(initial)
    expect(writes).toEqual([])
    expect(await instance.accessToken(app.url)).toBe("recovered")
    expect(stored()).toMatchObject({ accessToken: "recovered", refreshToken: "rotated" })
  })

  it("waits for the lock of other tabs and uses the tokens that another tab refreshed", async () => {
    const server = fakeApp()
    let stored: ConsoleOAuthTokens | undefined = tokens({ expiresAt: 0 })
    const instance = createConsoleOAuthRefresher({
      fetch: server.fetch,
      now: () => 0,
      read: () => stored,
      write: (_url, next) => { stored = next ?? undefined },
      lock: async (name, run) => {
        expect(name).toBe(`vitehub-console:oauth:${app.url}`)
        // Another tab held the lock and refreshed.
        stored = tokens({ accessToken: "from-other-tab", expiresAt: 900_000 })
        return await run()
      },
    })
    expect(await instance.accessToken(app.url)).toBe("from-other-tab")
    expect(server.fetch).not.toHaveBeenCalled()
  })
})

describe("refresh across tabs without Web Locks", () => {
  const tick = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, Math.min(milliseconds, 2)) })

  it("runs one tab at a time through a lease in storage", async () => {
    const storage = memoryProjectStorage()
    const events: string[] = []
    const tab = (id: string) => storageOAuthLock(storage, { sleep: tick })("vitehub-console:oauth:x", async () => {
      events.push(`${id} start`)
      await tick(5)
      events.push(`${id} end`)
      return id
    })
    expect(await Promise.all([tab("a"), tab("b"), tab("c")])).toEqual(["a", "b", "c"])
    for (let index = 0; index < events.length; index += 2) expect(events[index]!.split(" ")[0]).toBe(events[index + 1]!.split(" ")[0])
    expect(storage.getItem("vitehub-console:oauth:x:lease")).toBe("")
  })

  it("takes over a lease that its tab left behind", async () => {
    const storage = memoryProjectStorage()
    storage.setItem("vitehub-console:oauth:x:lease", JSON.stringify({ owner: "closed-tab", until: 1_000 }))
    let now = 0
    const sleep = async (milliseconds: number) => { now += milliseconds }
    expect(await storageOAuthLock(storage, { now: () => now, sleep })("vitehub-console:oauth:x", async () => "ran")).toBe("ran")
    expect(now).toBeGreaterThanOrEqual(1_000)
  })

  it("keeps a slow callback exclusive beyond the lease TTL and stops renewing after release", async () => {
    vi.useFakeTimers()
    const storage = memoryProjectStorage()
    const ttl = 300
    const name = "vitehub-console:oauth:x"
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const firstRun = vi.fn(async () => { await pending; return "first" })
    const secondRun = vi.fn(async () => "second")
    const first = storageOAuthLock(storage, { ttl })(name, firstRun)
    await vi.advanceTimersByTimeAsync(50)
    expect(firstRun).toHaveBeenCalledOnce()
    const second = storageOAuthLock(storage, { ttl })(name, secondRun)
    await vi.advanceTimersByTimeAsync(ttl * 3)
    const overlapped = secondRun.mock.calls.length > 0
    release()
    expect(await first).toBe("first")
    await vi.advanceTimersByTimeAsync(150)
    expect(await second).toBe("second")
    expect(overlapped).toBe(false)
    expect(storage.getItem(`${name}:lease`)).toBe("")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("lets two tabs share one refresh", async () => {
    const server = fakeApp({ refreshTokens: ["refresh-0"] })
    const storage = memoryProjectStorage()
    storage.setItem("tokens", JSON.stringify(tokens({ accessToken: "access-0", expiresAt: 0, refreshToken: "refresh-0" })))
    const tab = () => createConsoleOAuthRefresher({
      fetch: server.fetch,
      lock: storageOAuthLock(storage, { sleep: tick }),
      now: () => 0,
      read: () => JSON.parse(storage.getItem("tokens") ?? "null") ?? undefined,
      write: (_url, next) => storage.setItem("tokens", JSON.stringify(next)),
    })
    expect(await Promise.all([tab().accessToken(app.url), tab().accessToken(app.url)])).toEqual(["access-1", "access-1"])
    expect(server.calls.filter(call => call.url.endsWith("/oauth2/token"))).toHaveLength(1)
  })

  it("keeps the tokens of another tab when its own refresh token was already rotated", async () => {
    let release!: () => void
    const server = fakeApp({ refreshTokens: ["refresh-0"], tokenDelay: new Promise<void>((resolve) => { release = resolve }) })
    let stored: ConsoleOAuthTokens | undefined = tokens({ accessToken: "access-0", expiresAt: 0, refreshToken: "refresh-0" })
    // Two tabs with no lock at all: both send refresh-0, and the server accepts only the first.
    const tab = () => createConsoleOAuthRefresher({ fetch: server.fetch, now: () => 0, read: () => stored, write: (_url, next) => { stored = next ?? undefined } })
    const answers = Promise.all([tab().accessToken(app.url), tab().accessToken(app.url)])
    release()
    expect(await answers).toEqual(["access-1", "access-1"])
    expect(stored).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" })
  })
})

describe("OAuth sign-in of a hosted Console", () => {
  async function hosted(server: ReturnType<typeof fakeApp>, storage = memoryProjectStorage(), lock?: ConsoleOAuthLock) {
    vi.stubGlobal("fetch", server.fetch)
    const session = await import("../src/console/runtime/client/project-session.ts")
    // The session sets the transport of its own module graph, which `vi.resetModules()` renews for each test.
    const { projectFetch } = await import("../src/console/runtime/client/project.ts")
    const navigate = vi.fn()
    const tab = memoryProjectStorage()
    const state = session.startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate, pageOrigin: consoleOrigin, storage, sessionStorage: tab, durableStorage: true, ...(lock ? { lock } : {}) })
    return { navigate, projectFetch, session, state, storage, tab }
  }

  async function signIn(server: ReturnType<typeof fakeApp>, storage = memoryProjectStorage(), lock?: ConsoleOAuthLock) {
    const context = await hosted(server, storage, lock)
    const linked = await context.session.linkConsoleProject("app.example.com")
    expect(linked).toEqual({ kind: "oauth", target: app, resourceMetadata })
    expect(await context.session.startConsoleOAuthSignIn(app, resourceMetadata)).toBeUndefined()
    const authorizationUrl = String(context.navigate.mock.calls[0]![0])
    const code = server.authorize(authorizationUrl)
    const state = new URL(authorizationUrl).searchParams.get("state")!
    return { ...context, authorizationUrl, code, state }
  }

  it.each(["authorization", "request", "upload"] as const)("keeps %s bound to its project after the session selects another project", async (operation) => {
    const server = fakeApp({ refreshTokens: ["refresh-a"] })
    const storage = memoryProjectStorage()
    const store = createConsoleProjectStore(storage)
    const first = store.save({ url: app.url, oauth: tokens({ accessToken: "access-a", refreshToken: "refresh-a", expiresAt: Date.now() + 900_000 }) })
    const otherUrl = "https://other.example.com"
    const other = store.save({ url: otherUrl, oauth: tokens({ accessToken: "access-b", refreshToken: "refresh-b", expiresAt: Date.now() + 900_000, issuer: `${otherUrl}/api/auth`, resource: `${otherUrl}/_vitehub`, tokenEndpoint: `${otherUrl}/api/auth/oauth2/token` }) })
    store.select(first.id)
    const { projectFetch, session } = await hosted(server, storage)
    const { consoleProject, projectRequest } = await import("../src/console/runtime/client/project.ts")
    const transport = consoleProject()
    let request: Promise<Response> | undefined
    let release!: (response: Response) => void
    if (operation === "request") {
      let started!: () => void
      const sent = new Promise<void>((resolve) => { started = resolve })
      server.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
        release = resolve
        started()
      }))
      request = projectFetch("/_vitehub/rpc/__call", { method: "POST", body: "{}" })
      await sent
    }
    const upload = operation === "upload" ? await projectRequest("/_vitehub/rpc/__upload") : undefined
    // The session can select a new project while an earlier request still owns the old transport.
    session.switchConsoleProject(other.id)
    expect(session.useConsoleProjects().current.value?.url).toBe(other.url)
    if (operation === "authorization") {
      expect(await transport.authorization?.()).toBe("Bearer access-a")
    }
    else if (upload) {
      expect(upload.url).toBe(`${app.url}/_vitehub/rpc/__upload`)
      expect(await upload.renew('Bearer error="invalid_token"')).toEqual({ authorization: "Bearer access-1" })
    }
    else {
      release(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } }))
      const response = await request
      const sent = server.fetch.mock.calls.filter(([url]) => String(url) === `${app.url}/_vitehub/rpc/__call`)
      expect(sent.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual(["Bearer access-a", "Bearer access-1"])
      expect(response?.status).toBe(200)
    }
  })

  it("keeps a failed refresh of an earlier project from changing the selected project's gate", async () => {
    let release!: () => void
    const server = fakeApp({ tokenDelay: new Promise<void>((resolve) => { release = resolve }) })
    const storage = memoryProjectStorage()
    const store = createConsoleProjectStore(storage)
    const first = store.save({ url: app.url, oauth: tokens({ expiresAt: Date.now() + 900_000 }) })
    const other = store.save({ url: "https://other.example.com", token: "console-b" })
    store.select(first.id)
    const { session, state } = await hosted(server, storage)
    const { consoleProject } = await import("../src/console/runtime/client/project.ts")
    const renewal = consoleProject().renew!(new Response(null, { status: 401 }), "Bearer access-1")
    await vi.waitFor(() => expect(server.calls.some(call => call.url === `${issuer}/oauth2/token`)).toBe(true))
    session.switchConsoleProject(other.id)
    await vi.waitFor(() => expect(state.gate.value.kind).toBe("problem"))
    const gate = state.gate.value
    release()
    expect(await renewal).toBeUndefined()
    expect(state.gate.value).toBe(gate)
  })

  it("stays on the page when the person closed the dialog before the sign-in started", async () => {
    const context = await hosted(fakeApp())
    await context.session.linkConsoleProject("app.example.com")
    const closed = new AbortController()
    closed.abort()
    await expect(context.session.startConsoleOAuthSignIn(app, resourceMetadata, closed.signal)).rejects.toThrow()
    // Also when the dialog closes while the PKCE challenge is hashed, the last step before the redirect.
    const hashing = new AbortController()
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      hashing.abort()
      return digest(...args)
    })
    await expect(context.session.startConsoleOAuthSignIn(app, resourceMetadata, hashing.signal)).rejects.toThrow()
    spy.mockRestore()
    expect(context.navigate).not.toHaveBeenCalled()
  })

  it("does not start a sign-in when the browser storage would not survive the redirect", async () => {
    const server = fakeApp()
    vi.stubGlobal("fetch", server.fetch)
    const session = await import("../src/console/runtime/client/project-session.ts")
    const navigate = vi.fn()
    const options = { base: "", home: "/", mode: "hosted" as const, navigate, pageOrigin: consoleOrigin, storage: memoryProjectStorage() }
    for (const blocked of [{ durableStorage: false, sessionStorage: memoryProjectStorage() }, {}]) {
      session.startConsoleProjects({ ...options, ...blocked })
      expect(await session.startConsoleOAuthSignIn(app, resourceMetadata)).toEqual({
        title: "This browser blocks site data",
        message: "Allow site data for console.example.com to sign in, or use `auth: \"token\"` in the project.",
      })
    }
    expect(navigate).not.toHaveBeenCalled()
    expect(server.fetch).not.toHaveBeenCalled()
  })

  it("sends the browser to the authorization endpoint with PKCE S256 and the Console resource", async () => {
    const server = fakeApp()
    const { authorizationUrl, tab } = await signIn(server)
    const url = new URL(authorizationUrl)
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/oauth2/authorize`)
    expect(Object.fromEntries([...url.searchParams].filter(([key]) => key !== "state" && key !== "code_challenge"))).toEqual({
      client_id: `${consoleOrigin}/oauth-client.json`,
      code_challenge_method: "S256",
      redirect_uri: `${consoleOrigin}/oauth/callback`,
      resource: "https://app.example.com/_vitehub",
      response_type: "code",
      scope: "vitehub:read vitehub:write offline_access",
    })
    const [stored] = JSON.parse(tab.getItem(consoleOAuthStateStorageKey) ?? "[]")
    expect(stored).toMatchObject({ projectUrl: app.url, state: url.searchParams.get("state"), verifier: expect.stringMatching(/^[\w-]{43}$/) })
    expect(url.searchParams.get("code_challenge")).toBe(await consoleCodeChallenge(stored.verifier))
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{22}$/)
  })

  it("exchanges the code, keeps the tokens with the project, and opens it", async () => {
    const server = fakeApp()
    const { code, session, state, storage } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(issuer)}`)

    const projects = session.useConsoleProjects()
    expect(projects.gate.value).toEqual({ kind: "ready" })
    expect(projects.info.value?.name).toBe("Shop")
    const [project] = createConsoleProjectStore(storage).list()
    expect(project).toMatchObject({ url: app.url, label: "Shop", oauth: { accessToken: "access-1", refreshToken: "refresh-1", issuer } })
    expect(createConsoleProjectStore(storage).active()?.id).toBe(project!.id)
    const exchange = server.calls.find(call => call.body.get("grant_type") === "authorization_code")!
    expect([...exchange.body.keys()].sort()).toEqual(["client_id", "code", "code_verifier", "grant_type", "redirect_uri", "resource"])

    // The same callback cannot finish twice.
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    expect(projects.gate.value).toMatchObject({ kind: "problem", home: true, problem: { title: "This sign-in cannot finish here" } })
  })

  it.each([
    ["a denied consent", (state: string) => `?error=access_denied&state=${state}`, "The Console was not allowed"],
    ["another issuer", (state: string, code: string) => `?code=${code}&state=${state}&iss=https%3A%2F%2Fevil.example.com`, "The answer came from another server"],
    ["a code that the app refuses", (state: string) => `?code=wrong&state=${state}`, "app.example.com did not issue a token"],
  ])("shows the sign-in again after %s", async (_name, query, title) => {
    const server = fakeApp()
    const { code, session, state } = await signIn(server)
    await session.finishConsoleOAuthSignIn(query(encodeURIComponent(state), code))
    expect(session.useConsoleProjects().gate.value).toMatchObject({ kind: "oauth", target: app, problem: { title } })
  })

  it("requires iss when the authorization server says that it sends it", async () => {
    const server = fakeApp({ issuerInResponse: true })
    const { code, session, state, tab } = await signIn(server)
    expect(JSON.parse(tab.getItem(consoleOAuthStateStorageKey) ?? "[]")[0]).toMatchObject({ issuer, issuerInResponse: true, tokenEndpoint: `${issuer}/oauth2/token` })
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    expect(session.useConsoleProjects().gate.value).toMatchObject({ kind: "oauth", problem: { title: "The answer came from another server" } })
    expect(server.calls.some(call => call.url.endsWith("/oauth2/token"))).toBe(false)
  })

  it("checks iss on an error answer too", async () => {
    const server = fakeApp({ issuerInResponse: true })
    const { session, state } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?error=access_denied&state=${encodeURIComponent(state)}`)
    expect(session.useConsoleProjects().gate.value).toMatchObject({ kind: "oauth", problem: { title: "The answer came from another server" } })
  })

  it("finishes with the issuer and the token endpoint of the state when the server does not send iss", async () => {
    const server = fakeApp({ issuerInResponse: false })
    const { code, session, state } = await signIn(server)
    // Extra parameters in the answer cannot point the token request somewhere else.
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}&token_endpoint=https%3A%2F%2Fevil.example.com%2Ftoken`)
    expect(session.useConsoleProjects().gate.value).toEqual({ kind: "ready" })
    const tokenCalls = server.calls.filter(call => call.method === "POST" && call.body.has("grant_type"))
    expect(tokenCalls.map(call => call.url)).toEqual([`${issuer}/oauth2/token`])
  })

  it("drops the Console token of a project that signs in with OAuth now", async () => {
    const server = fakeApp()
    const storage = memoryProjectStorage()
    createConsoleProjectStore(storage).save({ url: app.url, token: "old-console-token" })
    const { navigate, projectFetch, session } = await hosted(server, storage)
    expect(await session.startConsoleOAuthSignIn(app, resourceMetadata)).toBeUndefined()
    const authorizationUrl = String(navigate.mock.calls[0]![0])
    const code = server.authorize(authorizationUrl)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${new URL(authorizationUrl).searchParams.get("state")}`)
    expect(createConsoleProjectStore(storage).find(app.url)?.token).toBeUndefined()
    server.calls.length = 0
    await projectFetch("/_vitehub/rpc/__call", { method: "POST", body: "{}" })
    expect(server.calls.map(call => call.authorization)).toEqual(["Bearer access-1"])
  })

  it("refuses a callback that is older than 10 minutes", async () => {
    const server = fakeApp()
    const { code, session, state, tab } = await signIn(server)
    const [entry] = JSON.parse(tab.getItem(consoleOAuthStateStorageKey) ?? "[]")
    tab.setItem(consoleOAuthStateStorageKey, JSON.stringify([{ ...entry, createdAt: Date.now() - consoleOAuthStateLifetime - 1 }]))
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    expect(session.useConsoleProjects().gate.value).toMatchObject({ kind: "oauth", problem: { title: "The sign-in took too long" } })
    expect(server.calls.some(call => call.url.endsWith("/oauth2/token"))).toBe(false)
  })

  it("refreshes once and sends the request again when the project refuses the access token", async () => {
    const server = fakeApp()
    const { code, projectFetch, session, state, storage } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    server.expire("access-1")
    server.calls.length = 0

    const responses = await Promise.all([1, 2].map(() => projectFetch("/_vitehub/rpc/__call", { method: "POST", body: "{}" })))
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(server.calls.filter(call => call.body.get("grant_type") === "refresh_token")).toHaveLength(1)
    expect(server.calls.filter(call => call.url.endsWith("/rpc/__call")).map(call => call.authorization)).toEqual(["Bearer access-1", "Bearer access-1", "Bearer access-2", "Bearer access-2"])
    expect(createConsoleProjectStore(storage).find(app.url)?.oauth?.refreshToken).toBe("refresh-2")
  })

  it("asks to sign in again when the refresh token stops working", async () => {
    const server = fakeApp()
    const { code, projectFetch, session, state, storage } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    server.expire("access-1")
    await server.fetch(`${issuer}/oauth2/revoke`, { method: "POST", body: "token=refresh-1" })

    const response = await projectFetch("/_vitehub/rpc/__call", { method: "POST", body: "{}" })
    expect(response.status).toBe(401)
    expect(createConsoleProjectStore(storage).find(app.url)?.oauth).toBeUndefined()
    expect(session.useConsoleProjects().gate.value).toMatchObject({ kind: "oauth", target: app, problem: { title: "Your sign-in to app.example.com ended" } })
  })

  it("revokes the refresh token when it forgets the project", async () => {
    const server = fakeApp()
    const { code, navigate, session, state, storage } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    const id = createConsoleProjectStore(storage).find(app.url)!.id
    expect(server.hasRefreshToken("refresh-1")).toBe(true)

    await session.forgetConsoleProject(id)
    const revocation = server.calls.find(call => call.url === `${issuer}/oauth2/revoke`)!
    expect(Object.fromEntries(revocation.body)).toEqual({ client_id: `${consoleOrigin}/oauth-client.json`, token: "refresh-1", token_type_hint: "refresh_token" })
    expect(server.hasRefreshToken("refresh-1")).toBe(false)
    expect(JSON.parse(storage.getItem(consoleProjectsStorageKey) ?? "").projects).toEqual([])
    expect(navigate).toHaveBeenLastCalledWith("/")
  })

  it("revokes the refresh token and keeps the project when it signs out", async () => {
    const server = fakeApp()
    const { code, session, state, storage } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)

    await session.signOutConsoleProject()
    expect(server.hasRefreshToken("refresh-1")).toBe(false)
    const project = createConsoleProjectStore(storage).find(app.url)
    expect(project).toMatchObject({ label: "Shop", url: app.url })
    expect(project?.oauth).toBeUndefined()
  })

  it("clears both credential types when signing out of a project", async () => {
    const server = fakeApp()
    const { code, session, state, storage } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    const store = createConsoleProjectStore(storage)
    store.save({ url: app.url, token: "console-token" })

    await session.signOutConsoleProject()
    expect(store.find(app.url)).toMatchObject({ label: "Shop", url: app.url })
    expect(store.find(app.url)?.token).toBeUndefined()
    expect(store.find(app.url)?.oauth).toBeUndefined()
  })

  it.each(["sign out", "forget"])("finishes local %s without waiting for revocation", async (action) => {
    const server = fakeApp()
    const { code, session, state, storage, navigate } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    const id = createConsoleProjectStore(storage).find(app.url)!.id
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const fetch = server.fetch.getMockImplementation()!
    server.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/revoke")) await pending
      return await fetch(input, init)
    })
    navigate.mockClear()
    let finished = false
    const removal = (action === "forget" ? session.forgetConsoleProject(id) : session.signOutConsoleProject()).then(() => { finished = true })
    try {
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/"), { timeout: 500 })
      expect(finished).toBe(true)
      expect(createConsoleProjectStore(storage).get(id)?.oauth).toBeUndefined()
    }
    finally {
      release()
      await removal
    }
  })

  it.each([
    ["sign out", 1],
    ["forget", 2],
    ["forget", 3],
  ] as const)("serializes %s with refresh persistence at storage read %i", async (action, readNumber) => {
    // A shared lock service models navigator.locks in two independent tab module graphs.
    const queues = new Map<string, Promise<unknown>>()
    const lock: ConsoleOAuthLock = async (name, run) => {
      const previous = queues.get(name) ?? Promise.resolve()
      const next = previous.then(run)
      queues.set(name, next.catch(() => {}))
      return await next
    }
    const data = memoryProjectStorage()
    let reads = 0
    let remaining = 0
    let remove: (() => Promise<void>) | undefined
    let removal: Promise<void> | undefined
    const storage = {
      getItem: (key: string) => {
        const snapshot = data.getItem(key)
        // Let the other tab run after this storage read but before the following write.
        if (key === consoleProjectsStorageKey && remaining && ++reads === remaining) {
          remaining = 0
          removal = remove!()
        }
        return snapshot
      },
      setItem: data.setItem,
    }
    const server = fakeApp()
    const { code, session, state } = await signIn(server, storage, lock)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    const id = createConsoleProjectStore(storage).find(app.url)!.id
    vi.resetModules()
    const other = await hosted(server, storage, lock)
    remove = () => action === "forget" ? other.session.forgetConsoleProject(id) : other.session.signOutConsoleProject()
    const fetch = server.fetch.getMockImplementation()!
    server.fetch.mockImplementation(async (input, init) => {
      const response = await fetch(input, init)
      if (new URLSearchParams(String(init?.body ?? "")).get("grant_type") === "refresh_token") remaining = readNumber
      return response
    })

    await session.useConsoleProjects().refresher.accessToken(app.url, { rejected: "access-1" })
    expect(removal).toBeDefined()
    await removal
    const saved = createConsoleProjectStore(storage).get(id)
    if (action === "forget") expect(createConsoleProjectStore(storage).list()).toEqual([])
    else expect(saved?.oauth).toBeUndefined()
    expect(server.hasRefreshToken("refresh-2")).toBe(false)
  })

  it("forgets the project even when the revocation fails", async () => {
    const server = fakeApp()
    const { code, session, state, storage } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    const id = createConsoleProjectStore(storage).find(app.url)!.id
    server.fetch.mockImplementation(async () => { throw new TypeError("Failed to fetch") })

    await session.forgetConsoleProject(id)
    expect(createConsoleProjectStore(storage).list()).toEqual([])
  })

  it.each(["same tab", "other tab"])("keeps a project signed out when a refresh finishes later in the %s", async (tab) => {
    const server = fakeApp()
    const { code, session, state, storage } = await signIn(server)
    await session.finishConsoleOAuthSignIn(`?code=${code}&state=${encodeURIComponent(state)}`)
    let signingOut = session
    if (tab === "other tab") {
      vi.resetModules()
      signingOut = (await hosted(server, storage)).session
    }

    let release!: () => void
    let rotated!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const refreshing = new Promise<void>((resolve) => { rotated = resolve })
    const fetch = server.fetch.getMockImplementation()!
    server.fetch.mockImplementation(async (input, init) => {
      const response = await fetch(input, init)
      if (new URLSearchParams(String(init?.body ?? "")).get("grant_type") === "refresh_token") {
        // Rotation wins at the server, but its answer reaches the Console after sign-out.
        rotated()
        await pending
      }
      return response
    })
    const refresh = session.useConsoleProjects().refresher.accessToken(app.url, { rejected: "access-1" })
    await refreshing
    expect(server.hasRefreshToken("refresh-2")).toBe(true)
    await signingOut.signOutConsoleProject()
    expect(createConsoleProjectStore(storage).find(app.url)?.oauth).toBeUndefined()
    release()

    expect(await refresh).toBeUndefined()
    expect(createConsoleProjectStore(storage).find(app.url)?.oauth).toBeUndefined()
    expect(server.hasRefreshToken("refresh-2")).toBe(false)
  })
})

describe("project snapshot of a request", () => {
  it("sends a token only to the project that it belongs to, also when another project opens during a refresh", async () => {
    const { projectFetch, projectRequest, setConsoleProject: open } = await import("../src/console/runtime/client/project.ts")
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 401 }))
    vi.stubGlobal("fetch", fetch)
    let refreshed!: (value: string) => void
    const refresh = new Promise<string>((resolve) => { refreshed = resolve })
    const renewed = vi.fn(async () => "Bearer a-2")
    open({ origin: "https://a.example.com", base: "", authorization: () => refresh, renew: renewed })

    const request = projectFetch("/_vitehub/rpc/__call", { method: "POST", body: "{}" })
    const upload = projectRequest("/_vitehub/rpc/__upload", { "x-vitehub-console": "1" })
    // Project B opens while the token of project A is still refreshing.
    open({ origin: "https://b.example.com", base: "", authorization: () => "Bearer b-1" })
    refreshed("Bearer a-1")
    await request

    const sent = fetch.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get("authorization")])
    expect(sent).toEqual([["https://a.example.com/_vitehub/rpc/__call", "Bearer a-1"], ["https://a.example.com/_vitehub/rpc/__call", "Bearer a-2"]])
    expect(renewed).toHaveBeenCalledOnce()
    const prepared = await upload
    expect({ url: prepared.url, headers: prepared.headers }).toEqual({ url: "https://a.example.com/_vitehub/rpc/__upload", headers: { "x-vitehub-console": "1", authorization: "Bearer a-1" } })
    // The renewal of the upload also belongs to project A.
    expect(await prepared.renew(null)).toEqual({ "x-vitehub-console": "1", authorization: "Bearer a-2" })
  })
})

describe("browser storage", () => {
  it("falls back to memory when the browser refuses writes", () => {
    const refusing = { getItem: () => null, removeItem: () => {}, setItem: () => { throw new DOMException("Quota", "QuotaExceededError") } }
    const opened = openConsoleStorage(() => refusing)
    expect(opened.durable).toBe(false)
    opened.storage.setItem("a", "1")
    expect(opened.storage.getItem("a")).toBe("1")
    expect(openConsoleStorage(() => { throw new DOMException("Blocked", "SecurityError") }).durable).toBe(false)
    const values = new Map<string, string>()
    const working = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => void values.delete(key), setItem: (key: string, value: string) => void values.set(key, value) }
    expect(openConsoleStorage(() => working)).toEqual({ storage: working, durable: true })
    expect(values.size).toBe(0)
  })
})

describe("media upload with OAuth", () => {
  it.each([false, true])("handles an upload rejected by the project with cancellation during renewal: %s", async (cancel) => {
    const sent: (string | undefined)[] = []
    class FakeUpload {
      headers: Record<string, string> = {}
      listeners: Record<string, () => void> = {}
      response: unknown
      responseType = ""
      status = 0
      upload = { addEventListener: () => {} }
      challenge: string | null = null
      open() {}
      abort() {}
      setRequestHeader(name: string, value: string) { this.headers[name] = value }
      getResponseHeader(name: string) { return name === "www-authenticate" ? this.challenge : null }
      addEventListener(type: string, listener: () => void) { this.listeners[type] = listener }
      send() {
        sent.push(this.headers.authorization)
        if (this.headers.authorization === "Bearer old") {
          this.status = 401
          this.challenge = `Bearer realm="vitehub-console", error="invalid_token", resource_metadata="${resourceMetadata}"`
          this.response = { ok: false, status: 401, code: "CONSOLE_SIGN_IN_REQUIRED" }
        }
        else {
          this.status = 200
          this.response = { ok: true, value: { duplicate: false, file: { pathname: "a.png" } } }
        }
        queueMicrotask(() => this.listeners.load?.())
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeUpload)
    const { setConsoleProject: open } = await import("../src/console/runtime/client/project.ts")
    const { createConsoleMediaClient } = await import("../src/console/runtime/client/media-library.ts")
    const controller = new AbortController()
    const renew = vi.fn(async (response: Response) => {
      if (cancel) controller.abort()
      return /invalid_token/.test(response.headers.get("www-authenticate") ?? "") ? "Bearer new" : undefined
    })
    open({ origin: "https://app.example.com", base: "", authorization: () => "Bearer old", renew })
    const upload = createConsoleMediaClient("/api/_vitehub/console/media", "docs").upload(new File(["x"], "a.png", { type: "image/png" }), { signal: controller.signal })
    if (cancel) {
      await expect(upload).rejects.toMatchObject({ name: "AbortError" })
      expect(sent).toEqual(["Bearer old"])
    }
    else {
      expect(await upload).toEqual({ duplicate: false, file: { pathname: "a.png" } })
      expect(sent).toEqual(["Bearer old", "Bearer new"])
    }
    expect(renew).toHaveBeenCalledOnce()
  })
})
