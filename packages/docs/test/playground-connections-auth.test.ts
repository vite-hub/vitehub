import { describe, expect, it, vi } from "vitest"

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock("vite-hub/auth/server", () => ({ useAuth: () => ({ api: { getSession } }) }))
// Exercise the real policy without requiring the framework facade build in the Docs shard.
vi.mock("vite-hub/cms/access", () => import("../../cms/src/access.ts"))

import actor from "../playground/server/connections-auth.ts"

describe("the demo Connections management actor", () => {
  it.each([undefined, "user", "viewer", "commenter", "editor", "publisher"])("denies role %s", async (role) => {
    getSession.mockResolvedValue(role ? { user: { id: "visitor", role } } : null)
    expect(await actor(new Request("https://docs-demo.vitehub.dev/_vitehub/connections"))).toBeUndefined()
  })

  it("uses the admin session and forwards the request headers", async () => {
    getSession.mockResolvedValue({ user: { id: "owner", role: "admin" } })
    const request = new Request("https://docs-demo.vitehub.dev/_vitehub/connections", { headers: { cookie: "session=admin" } })
    expect(await actor(request)).toBe("user:owner")
    expect(getSession).toHaveBeenLastCalledWith({ headers: request.headers })
  })
})
