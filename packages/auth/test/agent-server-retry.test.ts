import { describe, expect, it, vi } from "vitest"

import { agentAuth } from "../src/agent.ts"

// The server module fails to load once, as an import can fail during a development rebuild.
const server = vi.hoisted(() => ({ failures: 1 }))

vi.mock("../src/server.ts", () => {
  if (server.failures > 0) {
    server.failures--
    throw new Error("transient server import failure")
  }
  return {
    getAuth: () => ({ $context: Promise.resolve({ internalAdapter: { findUserById: async (id: string) => ({ id }) } }) }),
  }
})

describe("agentAuth", () => {
  it("loads the Auth server again on the next call after a failed load", async () => {
    const actor = { id: "user:u", kind: "user", meta: { authUserId: "u" } } as never

    await expect(agentAuth.user(actor)).rejects.toThrow()
    await expect(agentAuth.user(actor)).resolves.toEqual({ id: "u" })
  })
})
