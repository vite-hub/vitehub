import { describe, expect, it, vi } from "vitest"

const guard = vi.hoisted(() => ({ authorize: undefined as unknown }))

// The guard of `vite-hub/auth/server` checks the session and sends the cookies that renew it (packages/auth tests).
// Here a request with a cookie is Ada, in team t1, and a request without one is refused as the guard refuses it.
vi.mock("vite-hub/auth/server", () => ({
  withAuthorization: (authorize: unknown, handler: (request: Request, authorization: { session: object, user: { id: string } }) => Promise<Response>) => {
    guard.authorize = authorize
    return async (request: Request) => request.headers.has("cookie")
      ? handler(request, { session: { activeOrganizationId: "t1" }, user: { id: "u1" } })
      : Response.json({ status: 401, statusText: "Unauthorized", message: "Unauthorized.", data: { code: "SIGNED_OUT" } }, { status: 401 })
  },
}))
vi.mock("vite-hub/database", () => ({ useDatabase: () => ({ db: {} }) }))
vi.mock("../src/accounts.ts", () => ({ readConsoleAccount: async (_db: unknown, user: { id: string }, team: string | undefined) => ({ user, team }) }))

const { default: route } = await import("../server/api/account.get.ts")

describe("GET /api/account", () => {
  it("answers the account of the session's team behind the session guard", async () => {
    const response = await route.fetch(new Request("https://console.test/api/account", { headers: { cookie: "better-auth.session_token=ada" } }))
    expect(guard.authorize).toBe(true)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ user: { id: "u1" }, team: "t1" })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("answers 401 with SIGNED_OUT without a session", async () => {
    const response = await route.fetch(new Request("https://console.test/api/account"))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ data: { code: "SIGNED_OUT" } })
  })
})
