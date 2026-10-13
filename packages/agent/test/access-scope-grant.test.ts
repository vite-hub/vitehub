import { describe, expect, it } from "vitest"
import { grantWorkspaceAccessScope, trustedWorkspaceAccessScope } from "../src/access-runtime.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"

const granted = { all: false, paths: ["docs"], role: "viewer", scope: "support", sources: ["docs"] }
const forged = { workspaceScope: { all: true, paths: ["secrets"], role: "admin", scope: "all", sources: ["secrets"] } }

describe("Workspace access scope grant", () => {
  it("ignores a forged access context value without a grant", () => {
    const context = createAgentInvocationContextStore({ access: forged })

    expect(trustedWorkspaceAccessScope(context)).toBeUndefined()
  })

  it("keeps the granted scope when the access context value is overwritten", () => {
    const context = createAgentInvocationContextStore()
    grantWorkspaceAccessScope(context, granted)
    context.set("access", forged, { overwrite: true })

    expect(trustedWorkspaceAccessScope(context)).toEqual(granted)
    expect(context.get("access")?.workspaceScope?.scope).toBe("all")
  })

  it("does not let the public access copy or the input change the grant", () => {
    const context = createAgentInvocationContextStore()
    const input = { ...granted, paths: [...granted.paths], sources: [...granted.sources] }
    grantWorkspaceAccessScope(context, input)
    input.paths.push("secrets")
    context.get("access")?.workspaceScope?.paths.push("secrets")
    const grant = trustedWorkspaceAccessScope(context)

    expect(grant?.paths).toEqual(["docs"])
    expect(Object.isFrozen(grant)).toBe(true)
    expect(Object.isFrozen(grant?.paths)).toBe(true)
    expect(Object.isFrozen(grant?.sources)).toBe(true)
  })

  it("does not replace an access value that a caller set before the first grant", () => {
    const context = createAgentInvocationContextStore({ access: forged })

    expect(() => grantWorkspaceAccessScope(context, granted)).toThrow("already set")
    expect(trustedWorkspaceAccessScope(context)).toBeUndefined()
  })

  it("binds each grant to one invocation context", () => {
    const owner = createAgentInvocationContextStore()
    const other = createAgentInvocationContextStore()
    grantWorkspaceAccessScope(owner, granted)
    other.set("access", owner.get("access"))

    expect(trustedWorkspaceAccessScope(other)).toBeUndefined()
  })
})
