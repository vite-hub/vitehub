import { installedOperationSectionResolver } from "@vite-hub/internal/operations"
import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleOperationAccess, installConsoleAccess } from "../src/console/runtime/server/access.ts"

import type { ConsoleAuthorizeContext } from "../src/console/auth-types.ts"

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
})

describe("Agent operation authorization", () => {
  it.each([null, { id: "agent-user" }])("uses the Agent policy for discovery and execution, with user %j", async (user) => {
    const authorize = vi.fn((context: ConsoleAuthorizeContext) => context.via === "agent" ? { sections: ["kv:read"] } : false)
    installConsoleAccess({ authorize, mode: "token" })

    await expect(installedOperationSectionResolver()?.({ user })).resolves.toEqual(["kv:read"])
    await expect(consoleOperationAccess({ access: { mode: "agent", sections: ["kv:read"] }, surface: "agent", user })).resolves.toMatchObject({ mode: "token", sections: ["kv:read"] })
    expect(authorize.mock.calls).toHaveLength(2)
    for (const [context] of authorize.mock.calls) {
      expect(context.via).toBe("agent")
      expect(context.user).toEqual(user ?? undefined)
      expect([...context.request.headers]).toEqual([])
    }
  })

  it.each([null, { id: "agent-user" }])("denies discovery and execution under a signature-only policy, with user %j", async (user) => {
    const authorize = vi.fn((context: ConsoleAuthorizeContext) => context.via === "console" || context.via === "cli" ? { sections: ["kv"] } : false)
    installConsoleAccess({ authorize, mode: "token" })

    await expect(installedOperationSectionResolver()?.({ user })).resolves.toEqual([])
    await expect(consoleOperationAccess({ access: { mode: "agent", sections: ["kv"] }, surface: "agent", user })).rejects.toMatchObject({ statusCode: 403 })
    expect(authorize.mock.calls).toHaveLength(2)
    for (const [context] of authorize.mock.calls) {
      expect(context.via).toBe("agent")
      expect(context.user).toEqual(user ?? undefined)
      expect([...context.request.headers]).toEqual([])
    }
  })
})
