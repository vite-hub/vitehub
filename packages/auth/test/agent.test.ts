import { beforeEach, describe, expect, it, vi } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"
import { authenticated } from "../src/agent.ts"

import type { AgentInvokerOptions, AgentInvokerResolveContext } from "@vite-hub/agent"

const serverMocks = vi.hoisted(() => ({
  getAuthForRequest: vi.fn(),
  getSession: vi.fn(),
}))

vi.mock("../src/server.ts", () => ({
  getAuth: () => ({
    api: {
      getSession: serverMocks.getSession,
    },
  }),
  getAuthForRequest: serverMocks.getAuthForRequest,
}))

const defaultInvoker = {
  id: "anonymous:test",
  kind: "anonymous",
}

function createContext(
  overrides: Partial<AgentInvokerResolveContext> = {},
): AgentInvokerResolveContext {
  const store = new Map<string, unknown>()
  const context: AgentInvokerResolveContext["context"] = {
    entries: () => store.entries(),
    get<T = unknown>(id: string): T | undefined {
      return store.get(id) as T | undefined
    },
    has(id: string) {
      return store.has(id)
    },
    set(id: string, value: unknown) {
      store.set(id, value)
    },
    toJSON: () => Object.fromEntries(store),
  }
  return {
    context,
    defaultInvoker,
    input: {},
    profiles: [],
    runtime: "unknown",
    ...overrides,
  } as AgentInvokerResolveContext
}

async function resolve(options: AgentInvokerOptions, context = createContext()) {
  expect(options.resolve).toBeTypeOf("function")
  return options.resolve!(context)
}

describe("authenticated", () => {
  beforeEach(() => {
    serverMocks.getSession.mockReset()
    serverMocks.getAuthForRequest.mockReset()
    serverMocks.getAuthForRequest.mockReturnValue({
      api: {
        getSession: serverMocks.getSession,
      },
    })
  })

  it("reads Better Auth sessions authoritatively without refreshing cookies", async () => {
    const request = new Request("https://example.com/api/agent", {
      headers: { cookie: "better-auth.session_token=token_1" },
    })
    serverMocks.getSession.mockResolvedValue({
      session: { id: "session_0" },
      user: { email: "auth@example.com", id: "user_0" },
    })

    const invoker = await resolve(authenticated(), createContext({ request }))

    expect(serverMocks.getSession).toHaveBeenCalledWith({
      headers: request.headers,
      query: {
        disableCookieCache: true,
        disableRefresh: true,
      },
    })
    expect(invoker).toMatchObject({
      id: "user_0",
      kind: "authUser",
      label: "auth@example.com",
    })
  })

  it("maps an authenticated Better Auth session to an Agent Invoker by default", async () => {
    const invoker = await resolve(authenticated({
      source: () => ({
        session: { id: "session_1" },
        user: { email: "maxi@example.com", id: "user_1", name: "Maxi" },
      }),
    }))

    expect(invoker).toEqual({
      id: "user_1",
      kind: "authUser",
      label: "maxi@example.com",
      meta: {
        authSessionId: "session_1",
        authUserId: "user_1",
      },
    })
  })

  it("supports common identity overrides without a custom mapper", async () => {
    const invoker = await resolve(authenticated({
      id: ({ user }) => user.email,
      kind: "customer",
      label: ({ user }) => user.name,
      meta: ({ session, user }) => ({
        audience: user.email,
        authSessionId: "custom_session",
        authUserId: "custom_user",
        token: session.token,
      }),
      source: () => ({
        session: { id: "session_2", token: "token_2" },
        user: { email: "support@example.com", id: "user_2", name: "Support" },
      }),
    }))

    expect(invoker).toEqual({
      id: "support@example.com",
      kind: "customer",
      label: "Support",
      meta: {
        audience: "support@example.com",
        authSessionId: "session_2",
        authUserId: "user_2",
        token: "token_2",
      },
    })
  })

  it("allows full Agent Invoker mapping when the app has product-specific identity", async () => {
    const invoker = await resolve(authenticated({
      map: ({ user }) => ({
        id: String(user.organizationId),
        kind: "organization",
        label: String(user.email),
        meta: {
          authUserId: user.id,
        },
      }),
      source: () => ({
        session: { id: "session_3" },
        user: {
          email: "owner@example.com",
          id: "user_3",
          organizationId: "org_1",
        },
      }),
    }))

    expect(invoker).toEqual({
      id: "org_1",
      kind: "organization",
      label: "owner@example.com",
      meta: {
        authUserId: "user_3",
      },
    })
  })

  it("throws an HTTP-shaped auth error when auth is required", async () => {
    await expect(resolve(authenticated({
      source: () => undefined,
    }))).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      message: "[vitehub] Authentication required.",
      name: "ViteHubError",
    })
  })

  it.each([
    new Error("secret session failure"),
    new TypeError("fetch failed"),
  ])("normalizes Better Auth session failures, including %s", async (cause) => {
    const request = new Request("https://example.com/api/agent")
    serverMocks.getSession.mockRejectedValueOnce(cause)

    const error = await resolve(authenticated(), createContext({ request })).catch(error => error)

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({
      code: "AUTH_PROVIDER_OPERATION_FAILED",
      details: { operation: "get-session", provider: "better-auth" },
      message: "[vitehub] Authentication provider operation failed.",
      name: "ViteHubError",
    })
    expect(error.cause).toBe(cause)
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "AUTH_PROVIDER_OPERATION_FAILED",
      details: { operation: "get-session", provider: "better-auth" },
      message: "[vitehub] Authentication provider operation failed.",
      name: "ViteHubError",
    })
    expect(JSON.stringify(error)).not.toContain("secret")
  })

  it("normalizes provider failures with hostile prototypes", async () => {
    const request = new Request("https://example.com/api/agent")
    const cause = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("private prototype trap")
      },
    })
    serverMocks.getSession.mockRejectedValueOnce(cause)

    const error = await resolve(authenticated(), createContext({ request })).catch(error => error)

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({ code: "AUTH_PROVIDER_OPERATION_FAILED" })
    expect(error.cause).toBe(cause)
  })

  it("normalizes default label getter failures from Better Auth", async () => {
    const request = new Request("https://example.com/api/agent")
    const cause = new Error("protected email getter failure")
    serverMocks.getSession.mockResolvedValueOnce({
      session: {},
      user: {
        get email() {
          throw cause
        },
        id: "user_1",
      },
    })

    const error = await resolve(authenticated(), createContext({ request })).catch(error => error)

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({
      details: { operation: "get-session", provider: "better-auth" },
    })
    expect(error.cause).toBe(cause)
  })

  it("uses the snapshotted provider user id for the default label fallback", async () => {
    const request = new Request("https://example.com/api/agent")
    let reads = 0
    serverMocks.getSession.mockResolvedValueOnce({
      session: {},
      user: {
        get id() {
          reads++
          if (reads > 1) throw new Error("provider user id changed")
          return "user_1"
        },
      },
    })

    await expect(resolve(authenticated(), createContext({ request }))).resolves.toMatchObject({
      id: "user_1",
      label: "user_1",
    })
  })

  it("does not read default label fields when a mapper provides the invoker", async () => {
    const request = new Request("https://example.com/api/agent")
    serverMocks.getSession.mockResolvedValueOnce({
      session: {},
      user: {
        get email() {
          throw new Error("unused email getter")
        },
        id: "user_1",
      },
    })

    await expect(resolve(authenticated({
      map: () => ({ id: "mapped", kind: "custom" }),
    }), createContext({ request }))).resolves.toEqual({ id: "mapped", kind: "custom" })
  })

  it("snapshots the provider response wrapper before leaving the boundary", async () => {
    const request = new Request("https://example.com/api/agent")
    const session = { id: "session_1" }
    const user = { email: "auth@example.com", id: "user_1" }
    let userReads = 0
    serverMocks.getSession.mockResolvedValueOnce({
      session,
      get user() {
        userReads++
        if (userReads > 1) throw new Error("outer user getter reread")
        return user
      },
    })

    await expect(resolve(authenticated(), createContext({ request }))).resolves.toMatchObject({
      id: "user_1",
      label: "auth@example.com",
    })
    expect(userReads).toBe(1)
  })

  it("keeps default identity snapshots local when a provider reuses one response", async () => {
    const request = new Request("https://example.com/api/agent")
    let userReads = 0
    const authSession = {
      session: {},
      get user() {
        userReads++
        return { email: `user-${userReads}@example.com`, id: `user_${userReads}` }
      },
    }
    serverMocks.getSession.mockResolvedValue(authSession)

    const [first, second] = await Promise.all([
      resolve(authenticated(), createContext({ request })),
      resolve(authenticated(), createContext({ request })),
    ])

    expect(first).toMatchObject({ id: "user_1", label: "user-1@example.com" })
    expect(second).toMatchObject({ id: "user_2", label: "user-2@example.com" })
  })

  it("distinguishes invalid Better Auth responses from missing sessions", async () => {
    const request = new Request("https://example.com/api/agent")
    serverMocks.getSession.mockResolvedValueOnce(null)
    await expect(resolve(authenticated({ required: false }), createContext({ request }))).resolves.toBeUndefined()

    serverMocks.getSession.mockResolvedValueOnce({ session: {}, user: {} })
    await expect(resolve(authenticated(), createContext({ request }))).rejects.toEqual(
      new TypeError("Better Auth returned an invalid session response."),
    )

    serverMocks.getAuthForRequest.mockReturnValueOnce({ api: {} })
    await expect(resolve(authenticated(), createContext({ request }))).rejects.toEqual(
      new TypeError("Better Auth did not expose api.getSession()."),
    )
  })

  it("preserves the exact Better Auth session objects for custom mapping", async () => {
    const request = new Request("https://example.com/api/agent")
    const session = { id: "session_identity" }
    const user = { id: "user_identity", organization: { id: "org_identity" } }
    const authSession = { session, user }
    serverMocks.getSession.mockResolvedValue(authSession)

    await resolve(authenticated({
      map: (context) => {
        expect(context.auth).toBe(authSession)
        expect(context.session).toBe(session)
        expect(context.user).toBe(user)
        return { id: user.organization.id, kind: "organization" }
      },
    }), createContext({ request }))
  })

  it("preserves exact abort and custom extension failures", async () => {
    const request = new Request("https://example.com/api/agent")
    const abort = new DOMException("cancelled", "AbortError")
    serverMocks.getSession.mockRejectedValue(abort)
    await expect(resolve(authenticated(), createContext({ request }))).rejects.toBe(abort)

    const providerError = new ViteHubError("AUTH_PROVIDER_OPERATION_FAILED", "Custom provider failure.")
    serverMocks.getSession.mockRejectedValue(providerError)
    await expect(resolve(authenticated(), createContext({ request }))).rejects.toBe(providerError)

    const sourceError = new Error("custom source failed")
    await expect(resolve(authenticated({ source: () => { throw sourceError } }))).rejects.toBe(sourceError)

    const mapError = new Error("custom map failed")
    await expect(resolve(authenticated({
      map: () => { throw mapError },
      source: () => ({ session: {}, user: { id: "user_1" } }),
    }))).rejects.toBe(mapError)

    const valueError = new Error("custom value failed")
    await expect(resolve(authenticated({
      id: () => { throw valueError },
      source: () => ({ session: {}, user: { id: "user_1" } }),
    }))).rejects.toBe(valueError)
  })

  it("preserves normal Agent Invoker resolution when auth is optional", async () => {
    await expect(resolve(authenticated({
      required: false,
      source: () => undefined,
    }))).resolves.toBeUndefined()
  })

  it("preserves normal Agent Invoker resolution for optional non-HTTP invocations", async () => {
    await expect(resolve(authenticated({
      required: false,
    }))).resolves.toBeUndefined()
    expect(serverMocks.getSession).not.toHaveBeenCalled()
  })

  it("requires custom mappers to return an Agent Invoker", async () => {
    await expect(resolve(authenticated({
      map: () => undefined as never,
      source: () => ({
        session: { id: "session_4" },
        user: { id: "user_4" },
      }),
    }))).rejects.toThrow("[vitehub] authenticated({ map }) must return an Agent Invoker.")
  })

})
