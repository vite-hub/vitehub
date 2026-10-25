import { createOperationRegistry, defineOperation, installOperationSectionResolver } from "@vite-hub/internal/operations"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"

import { operations } from "../src/capabilities.ts"

import type { AgentActor, AgentCapabilityDefinition, AgentToolDefinition } from "../src/types.ts"

const seen: unknown[] = []
const whoami = defineOperation({
  description: "Say who is calling.",
  input: v.strictObject({ greeting: v.optional(v.string()) }),
  kind: "read",
  name: "demo.whoami",
  run: ({ greeting }, { actor, surface, user }) => {
    seen.push({ actor: actor?.id, surface, user: user?.id })
    return { greeting: greeting ?? "hi", user: user?.id ?? null }
  },
  section: "demo",
})
const rename = defineOperation({
  description: "Rename a thing.",
  input: v.strictObject({ name: v.string() }),
  kind: "write",
  name: "demo.rename",
  run: ({ name }) => ({ name }),
  section: "demo",
})
const remove = defineOperation({
  description: "Remove a thing.",
  input: v.strictObject({ dryRun: v.optional(v.boolean()), id: v.string() }),
  kind: "destructive",
  name: "demo.remove",
  readOnlyWhen: input => input.dryRun === true,
  run: ({ id }) => {
    if (id === "locked") throw Object.assign(new Error("The thing is locked."), { code: "DEMO_R0001", fix: "Unlock it first.", status: 409 })
    if (id === "boom") throw Object.assign(new Error("Storage is down."), { code: "DEMO_R0002", status: 500 })
    return { id }
  },
  section: "demo",
})
const other = defineOperation({ ...whoami, name: "other.whoami", section: "other" })
const lease = defineOperation({
  description: "Report the lease setting.",
  input: v.strictObject({}),
  kind: "write",
  name: "demo.lease",
  run: (_input, context) => ({ overrideLeases: context.overrideLeases ?? false, sections: context.access.sections, surface: context.surface }),
  section: "demo",
})
const registry = createOperationRegistry([{ operations: [whoami, rename, remove, other, lease] }])

afterEach(() => installOperationSectionResolver(undefined))

const actor: AgentActor = { id: "user_1", kind: "authUser", meta: { authUserId: "user_1" } }
const auth = { user: async (value: AgentActor | undefined) => value?.meta?.authUserId === "user_1" ? { id: "user_1", name: "Ada" } : null }

async function tools(capability: AgentCapabilityDefinition): Promise<Record<string, AgentToolDefinition>> {
  if (!(capability.tools instanceof Function)) throw new Error("operations() must resolve tools from the Invocation context")
  // SAFETY: The tools read only the fields that this context sets.
  return await capability.tools({ actor, agentIdentity: { name: "editor" }, capabilities: { auth }, context: new Map() } as never) as Record<string, AgentToolDefinition>
}

describe("operations capability", () => {
  it("exposes the included operations as tools named after them", async () => {
    const resolved = await tools(operations({ include: ["demo.*"], registry }))
    expect(Object.keys(resolved)).toEqual(["demo_lease", "demo_remove", "demo_rename", "demo_whoami"])
    expect(resolved.demo_whoami).toMatchObject({ description: "Say who is calling.", inputSchema: { properties: { greeting: { type: "string" } }, type: "object" } })
  })

  it("runs the operation as the user that the Actor stands for", async () => {
    const resolved = await tools(operations({ include: ["demo.whoami"], registry }))
    const result = await resolved.demo_whoami!.execute!({ greeting: "hello" } as never, {})
    expect(result).toEqual({ greeting: "hello", user: "user_1" })
    expect(seen.at(-1)).toEqual({ actor: "user_1", surface: "agent", user: "user_1" })
  })

  it("asks for approval of destructive operations by default, and as approve says", async () => {
    const decide = async (capability: AgentCapabilityDefinition, name: string, input: unknown = {}) => {
      const policy = (await tools(capability))[name]!.policy
      return policy instanceof Function ? await policy({ input, name }) : policy
    }
    expect(await decide(operations({ include: ["demo.*"], registry }), "demo_remove")).toBe("require-approval")
    expect(await decide(operations({ include: ["demo.*"], registry }), "demo_rename")).toBe("allow")
    expect(await decide(operations({ approve: "write", include: ["demo.*"], registry }), "demo_rename")).toBe("require-approval")
    expect(await decide(operations({ approve: "write", include: ["demo.*"], registry }), "demo_whoami")).toBe("allow")
    expect(await decide(operations({ approve: "never", include: ["demo.*"], registry }), "demo_remove")).toBe("allow")
    expect(await decide(operations({ approve: ["demo.rename"], include: ["demo.*"], registry }), "demo_rename")).toBe("require-approval")
  })

  it("runs a dry run without approval, since the operation says that it only reads", async () => {
    const policy = (await tools(operations({ include: ["demo.remove"], registry }))).demo_remove!.policy
    if (!(policy instanceof Function)) throw new Error("expected a policy function")
    expect(await policy({ input: { dryRun: true, id: "a" }, name: "demo_remove" })).toBe("allow")
    expect(await policy({ input: { id: "a" }, name: "demo_remove" })).toBe("require-approval")
  })

  it("offers only the operations of sections that console.authorize allows for the user", async () => {
    const calls: unknown[] = []
    installOperationSectionResolver(async (call) => {
      calls.push(call)
      return call.user?.id === "user_1" ? ["demo"] : []
    })
    const resolved = await tools(operations({ include: ["*"], registry }))
    expect(Object.keys(resolved)).toEqual(["demo_lease", "demo_remove", "demo_rename", "demo_whoami"])
    expect(calls).toEqual([{ actor, user: { id: "user_1", name: "Ada" } }])
    // The operation sees the allowed sections and the user, not "all".
    expect(await resolved.demo_lease!.execute!({} as never, {})).toMatchObject({ sections: ["demo"], surface: "agent" })
    expect(await resolved.demo_whoami!.execute!({} as never, {})).toMatchObject({ user: "user_1" })
  })

  it("offers nothing when the user may use no section, and everything without console.authorize", async () => {
    installOperationSectionResolver(async () => [])
    expect(Object.keys(await tools(operations({ include: ["*"], registry })))).toEqual([])
    installOperationSectionResolver(async () => "all")
    expect(Object.keys(await tools(operations({ include: ["other.*"], registry })))).toEqual(["other_whoami"])
    installOperationSectionResolver(undefined)
    expect(Object.keys(await tools(operations({ include: ["other.*"], registry })))).toEqual(["other_whoami"])
  })

  it("lets an Agent override edit leases only when the developer allowed it", async () => {
    const result = async (options: { overrideLeases?: boolean }) => (await (await tools(operations({ include: ["demo.lease"], registry, ...options }))).demo_lease!.execute!({} as never, {})) as { overrideLeases: boolean }
    expect((await result({})).overrideLeases).toBe(false)
    expect((await result({ overrideLeases: true })).overrideLeases).toBe(true)
  })

  it("returns input and conflict failures to the model and throws server failures", async () => {
    const resolved = await tools(operations({ include: ["demo.remove"], registry }))
    expect(await resolved.demo_remove!.execute!({ id: "locked" } as never, {})).toEqual({ error: { code: "DEMO_R0001", fix: "Unlock it first.", message: "The thing is locked." }, ok: false })
    expect(await resolved.demo_remove!.execute!({ id: 1 } as never, {})).toMatchObject({ error: { code: "INTERNAL_R0022" }, ok: false })
    await expect(resolved.demo_remove!.execute!({ id: "boom" } as never, {})).rejects.toMatchObject({ code: "DEMO_R0002" })
  })

  it("rejects options and names that match nothing", async () => {
    expect(() => operations({ include: [] })).toThrowError(/operations\(\) requires/)
    await expect(tools(operations({ include: ["nothing.*"], registry }))).rejects.toThrowError(/matches no operation/)
  })
})
