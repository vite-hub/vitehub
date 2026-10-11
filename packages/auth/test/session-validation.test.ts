import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineAuth } from "../src/index.ts"
import { withAuth } from "../src/server.ts"
const provider = vi.hoisted(() => ({ betterAuth: vi.fn(), getSession: vi.fn() }))
vi.mock("better-auth", () => ({ betterAuth: provider.betterAuth }))
describe("undefined session repro", () => {
 beforeEach(() => { provider.betterAuth.mockReset().mockReturnValue({ api: { getSession: provider.getSession } }); provider.getSession.mockResolvedValue(undefined) })
 it("rejects undefined as malformed", async () => {
   const guard = withAuth(() => "ok", defineAuth({ appName: "x" }))
   await expect(guard(new Request("https://example.com/private"))).rejects.toMatchObject({ code: "AUTH_R0012" })
 })
})
