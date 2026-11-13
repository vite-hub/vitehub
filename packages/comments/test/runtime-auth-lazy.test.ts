import { H3Event } from "h3"
import { expect, it, vi } from "vitest"

const auth = vi.hoisted(() => ({ loads: 0 }))
vi.mock("@vite-hub/auth/server", () => {
  auth.loads++
  const user = { id: "ada", name: "Ada" }
  return {
    createAuthForRequest: () => { throw new Error("GitHub sign-in is not configured in this test.") },
    getAuth: () => ({ $context: Promise.resolve({ internalAdapter: { listUsers: async () => [user] } }) }),
    useAuth: () => ({ api: { getSession: async () => ({ user }) } }),
  }
})

vi.mock("@vite-hub/auth/internal/server", () => ({
  createAuthForRequest: () => { throw new Error("GitHub sign-in is not configured in this test.") },
}))

it("loads ViteHub Auth on the first Comments request that needs a user, not at startup", async () => {
  // The generated Comments plugin and route import these modules when the server starts.
  const [runtime, { commentsAuthSession, commentsAuthUsers }] = await Promise.all([import("../src/runtime/index.ts"), import("../src/runtime/auth.ts")])
  expect(runtime.createCommentsGitHubLogin().configured()).toBe(false)
  expect(auth.loads).toBe(0)

  await expect(commentsAuthSession(new H3Event(new Request("http://site.test/")))).resolves.toEqual({ id: "ada", name: "Ada" })
  await expect(commentsAuthUsers.byIds(["ada"])).resolves.toEqual([expect.objectContaining({ id: "ada", name: "Ada" })])
  expect(auth.loads).toBe(1)
})
