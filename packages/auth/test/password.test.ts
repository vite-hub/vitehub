import { hashPassword, verifyPassword } from "better-auth/crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

const webContainer = vi.hoisted(() => ({ active: false }))
vi.mock("@vite-hub/web-container/env", () => ({ isWebContainer: () => webContainer.active }))

const { defineAuth } = await import("../src/definition.ts")
const { hashPasswordWithNoble, verifyPasswordWithNoble } = await import("../src/password.ts")
const { resolveAuthOptions } = await import("../src/runtime-options.ts")

afterEach(() => {
  webContainer.active = false
  vi.restoreAllMocks()
})

describe("Auth password hasher", () => {
  it("keeps Better Auth's default hasher outside a WebContainer", () => {
    const options = resolveAuthOptions(defineAuth({ emailAndPassword: { enabled: true } })).providerOptions
    expect(options.emailAndPassword).toEqual({ enabled: true })
  })

  it("uses the noble scrypt inside a WebContainer and reports it once", () => {
    webContainer.active = true
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const options = resolveAuthOptions(defineAuth({ emailAndPassword: { enabled: true } })).providerOptions
    expect(options.emailAndPassword).toEqual({ enabled: true, password: { hash: hashPasswordWithNoble, verify: verifyPasswordWithNoble } })
    // Plugins such as `username` hash through the same option when email and password sign-in is off.
    expect(resolveAuthOptions(defineAuth({})).providerOptions.emailAndPassword).toEqual({ enabled: false, password: { hash: hashPasswordWithNoble, verify: verifyPasswordWithNoble } })
    expect(info).toHaveBeenCalledOnce()
    expect(info.mock.calls[0]?.[0]).toContain("@noble/hashes")
  })

  it("keeps a hash or verify function from the Auth Definition", () => {
    webContainer.active = true
    vi.spyOn(console, "info").mockImplementation(() => {})
    const hash = async (password: string) => password
    const options = resolveAuthOptions(defineAuth({ emailAndPassword: { enabled: true, password: { hash } } })).providerOptions
    expect(options.emailAndPassword?.password).toEqual({ hash, verify: verifyPasswordWithNoble })
  })

  it("makes hashes that Better Auth's default hasher verifies, and the other way around", async () => {
    const password = "correct-horse-battery-staple"
    const fromNoble = await hashPasswordWithNoble(password)
    expect(fromNoble).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
    expect(await verifyPassword({ hash: fromNoble, password })).toBe(true)
    expect(await verifyPassword({ hash: fromNoble, password: "wrong" })).toBe(false)
    const fromNode = await hashPassword(password)
    expect(await verifyPasswordWithNoble({ hash: fromNode, password })).toBe(true)
    expect(await verifyPasswordWithNoble({ hash: fromNode, password: "wrong" })).toBe(false)
    await expect(verifyPasswordWithNoble({ hash: "no-separator", password })).rejects.toThrow("Invalid password hash")
  })
})
