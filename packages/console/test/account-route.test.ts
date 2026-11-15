import { describe, expect, it, vi } from "vitest"

const getSession = vi.fn()

vi.mock("vite-hub/auth/server", () => ({ useAuth: () => ({ api: { getSession } }) }))
vi.mock("vite-hub/database", () => ({ useDatabase: () => ({ db: {} }) }))
vi.mock("../src/accounts.ts", () => ({ readConsoleAccount: async (_db: unknown, user: { id: string }, team: string | undefined) => ({ user, team }) }))

const { default: route } = await import("../server/api/account.get.ts")

function renewal(): Headers {
  const headers = new Headers()
  headers.append("set-cookie", "better-auth.session_token=renewed; Path=/; HttpOnly")
  return headers
}

describe("GET /api/account", () => {
  it("answers the account with the cookie that renews the session", async () => {
    getSession.mockResolvedValueOnce({ headers: renewal(), response: { session: { activeOrganizationId: "t1" }, user: { id: "u1" } } })
    const response = await route.fetch(new Request("https://console.test/api/account", { headers: { cookie: "better-auth.session_token=old" } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ user: { id: "u1" }, team: "t1" })
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_token=renewed; Path=/; HttpOnly"])
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(getSession).toHaveBeenLastCalledWith(expect.objectContaining({ returnHeaders: true }))
  })

  it("answers 401 without a session, with the cookies of the session check", async () => {
    getSession.mockResolvedValueOnce({ headers: renewal(), response: null })
    const response = await route.fetch(new Request("https://console.test/api/account"))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ data: { code: "SIGNED_OUT" } })
    expect(response.headers.getSetCookie()).toHaveLength(1)
  })
})
