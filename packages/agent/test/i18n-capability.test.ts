import { describe, expect, it } from "vitest"

import { i18n } from "../src/capabilities/index.ts"

import type { AgentCapabilityDefinition, AgentToolDefinition } from "../src/types.ts"

function primitive() {
  const calls: unknown[] = []
  return {
    calls,
    handle: {
      status: async () => [{ locale: "es", messages: 3, published: 1, drafted: 0, missing: 2 }],
      missing: async (locale: string, options?: unknown) => {
        calls.push(["missing", locale, options])
        return locale === "fr"
          ? [{ code: "I18N_UNKNOWN_LOCALE", message: "`fr` is not one of the configured locales: es.", fix: "Pass one of `i18n.locales`." }, undefined] as const
          : [undefined, { items: [{ id: "oEE8vp", source: "Deploy your agent", origins: ["src/App.vue:3"] }], total: 1, cursor: null }] as const
      },
      save: async (input: unknown) => {
        calls.push(["save", input])
        return [undefined, { id: "oEE8vp", revision: "draft-1" }] as const
      },
      publish: async (options?: unknown) => {
        calls.push(["publish", options])
        return { revision: "published-1", published: 1 }
      },
    },
  }
}

async function tools(capability: AgentCapabilityDefinition, handle: unknown): Promise<Record<string, AgentToolDefinition>> {
  if (!(capability.tools instanceof Function)) throw new Error("i18n() must resolve tools from the Invocation context")
  // SAFETY: The i18n tools read only the fields that this context sets.
  return await capability.tools({ invoker: { id: "user-1", label: "Ana" }, capabilities: { i18n: handle }, context: new Map() } as never) as Record<string, AgentToolDefinition>
}

async function run(tool: AgentToolDefinition | undefined, input: unknown): Promise<unknown> {
  if (!tool?.execute) throw new Error("expected an executable tool")
  return await tool.execute(input as never, {} as never)
}

describe("i18n capability", () => {
  it("defines a write Capability over the i18n primitive and rejects invalid options", () => {
    expect(i18n()).toMatchObject({ id: "i18n", metadata: { approval: ["i18n_publish"], operations: ["read", "write", "publish"] }, mode: "write", requires: [{ primitive: "i18n" }] })
    expect(i18n({ operations: ["read"] })).toMatchObject({ metadata: { approval: [], operations: ["read"] }, mode: "read" })
    expect(i18n({ policy: "allow" }).metadata).toMatchObject({ approval: "allow" })
    for (const options of [{ operations: [] }, { operations: ["delete"] }, { policy: "maybe" }, { locales: ["es"] }]) {
      expect(() => i18n(options as never)).toThrow(expect.objectContaining({ code: "AGENT_C0014" }))
    }
  })

  it("lists missing messages, saves machine drafts by the Invoker, and publishes with approval", async () => {
    const { calls, handle } = primitive()
    const set = await tools(i18n(), handle)
    expect(Object.keys(set).sort()).toEqual(["i18n_list_missing", "i18n_publish", "i18n_save_translation", "i18n_status"])
    expect(await run(set.i18n_status, {})).toEqual({ ok: true, locales: [expect.objectContaining({ locale: "es", missing: 2 })] })
    expect(await run(set.i18n_list_missing, { locale: "es", limit: null, cursor: null })).toMatchObject({ ok: true, page: { total: 1 } })
    expect(await run(set.i18n_list_missing, { locale: "fr", limit: 10, cursor: "abc" })).toEqual({ ok: false, error: { code: "I18N_UNKNOWN_LOCALE", message: expect.any(String), fix: expect.any(String) } })
    expect(calls).toContainEqual(["missing", "fr", { limit: 10, cursor: "abc" }])

    expect(await run(set.i18n_save_translation, { locale: "es", source: "Deploy your agent", context: null, translation: "Despliega tu agente" })).toMatchObject({ ok: true })
    expect(calls).toContainEqual(["save", { locale: "es", source: "Deploy your agent", translation: "Despliega tu agente", review: "machine", by: "Ana" }])
    expect(await run(set.i18n_publish, { message: null })).toEqual({ ok: true, revision: "published-1", published: 1 })

    const policy = (tool: AgentToolDefinition | undefined) => tool?.policy instanceof Function ? tool.policy({ name: tool.name, input: {} } as never) : tool?.policy
    expect(await policy(set.i18n_save_translation)).toBe("allow")
    expect(await policy(set.i18n_publish)).toBe("require-approval")
  })

  it("exposes only the enabled tool groups and needs the i18n primitive", async () => {
    expect(Object.keys(await tools(i18n({ operations: ["read"] }), primitive().handle)).sort()).toEqual(["i18n_list_missing", "i18n_status"])
    await expect(tools(i18n(), undefined)).rejects.toThrow(/requires the i18n primitive/)
  })
})
