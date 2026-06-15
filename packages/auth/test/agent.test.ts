import { beforeEach, describe, expect, it, vi } from "vitest"

import { authenticated, AuthenticationRequiredError } from "../src/agent.ts"

import type { AgentInvokerOptions, AgentInvokerResolveContext } from "@vite-hub/agent"

const serverMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}))

vi.mock("../src/server.ts", () => ({
  getAuth: () => ({
    api: {
      getSession: serverMocks.getSession,
    },
  }),
  getAuthForRequest: () => ({
    api: {
      getSession: serverMocks.getSession,
    },
  }),
}))

const defaultInvoker = {
  id: "anonymous:test",
  kind: "anonymous",
}

function createContext(
  overrides: Partial<AgentInvokerResolveContext> = {},
): AgentInvokerResolveContext {
  const store = new Map<string, unknown>()
  return {
    context: {
      entries: () => store.entries(),
      get: id => store.get(id),
      has: id => store.has(id),
      set: (id, value) => {
        store.set(id, value)
      },
      toJSON: () => Object.fromEntries(store),
    },
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
      message: "[vitehub] Authentication required.",
      name: "AuthenticationRequiredError",
      statusCode: 401,
    })
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

  it("exposes the auth error class", () => {
    expect(new AuthenticationRequiredError()).toMatchObject({
      statusCode: 401,
    })
  })
})
