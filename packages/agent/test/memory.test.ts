import { describe, expect, it, vi } from "vitest"

import type { MemoryRecord, MemoryStoreAdapter } from "../src/memory.ts"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  waitUntil: vi.fn(),
})

function memoryRecord(record: Partial<MemoryRecord> & Pick<MemoryRecord, "content" | "id" | "kind">): MemoryRecord {
  return {
    content: record.content,
    createdAt: record.createdAt || "2026-05-18T00:00:00.000Z",
    digest: record.digest || `sha256:${record.id}`,
    id: record.id,
    kind: record.kind,
    scope: record.scope || { agent: "support" },
    status: record.status || "active",
    store: record.store || "agent",
    updatedAt: record.updatedAt || "2026-05-18T00:00:00.000Z",
    version: record.version || 1,
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    ...(record.pinned === undefined ? {} : { pinned: record.pinned }),
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
    ...(record.tags === undefined ? {} : { tags: record.tags }),
    ...(record.title === undefined ? {} : { title: record.title }),
  }
}

describe("agent memory capability", () => {
  it("adds record-oriented memory tools and preloads pinned procedural memory", async () => {
    const records = [memoryRecord({
      content: "Use gh CLI for GitHub operations.",
      id: "mem_1",
      kind: "procedural",
      pinned: true,
      title: "GitHub workflow",
    })]
    const adapter: MemoryStoreAdapter = {
      append: vi.fn(async request => ({ action: "created" as const, item: memoryRecord({ ...request, id: "mem_2" }) })),
      delete: vi.fn(async request => ({ deletedId: request.id, ok: true as const, tombstoneId: "mem_del_1" })),
      export: vi.fn(async () => ({ items: records })),
      read: vi.fn(async request => ({ item: records.find(record => record.id === request.id) || null })),
      search: vi.fn(async () => ({ items: [{ createdAt: records[0]!.createdAt, id: "mem_1", kind: "procedural", snippet: records[0]!.content, title: records[0]!.title, updatedAt: records[0]!.updatedAt }] })),
    }
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { memory } = await import("../src/capabilities.ts")
    let capturedTools: Record<string, { execute: (input: unknown) => Promise<unknown> | unknown, policy?: unknown }> = {}
    const agent = defineAgent({
      async run(context) {
        capturedTools = context.tools as typeof capturedTools
        return { text: Object.keys(context.tools || {}).sort().join(",") }
      },
      capabilities: [
        memory({
          stores: {
            agent: {
              adapter,
              allowKinds: ["procedural", "semantic"],
              read: { preload: [{ kind: "procedural", pinned: true }] },
              scope: { agent: "support" },
              write: { mode: "tool", policy: "allow" },
            },
          },
        }),
      ],
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      text: "memory_delete,memory_read,memory_remember,memory_search",
    })
    expect(adapter.export).toHaveBeenCalled()
    await expect(capturedTools.memory_search!.execute({ query: "github" })).resolves.toMatchObject({ items: [{ id: "mem_1" }] })
    await expect(capturedTools.memory_read!.execute({ id: "mem_1" })).resolves.toMatchObject({ item: { id: "mem_1" } })
    await expect(capturedTools.memory_remember!.execute({ content: "Prefer workspace JSONL.", kind: "semantic" })).resolves.toMatchObject({ item: { id: "mem_2" } })
    await expect(capturedTools.memory_delete!.execute({ id: "mem_1", reason: "obsolete" })).resolves.toMatchObject({ ok: true })
    expect(await (capturedTools.memory_remember!.policy as (context: { input?: unknown }) => unknown)({ input: {} })).toBe("allow")
  })

  it("preloads newest matching memory records first", async () => {
    const adapter: MemoryStoreAdapter = {
      append: vi.fn(),
      delete: vi.fn(),
      export: vi.fn(async () => ({
        items: [
          memoryRecord({ content: "Old workflow.", id: "mem_old", kind: "procedural", pinned: true, updatedAt: "2026-05-17T00:00:00.000Z" }),
          memoryRecord({ content: "New workflow.", id: "mem_new", kind: "procedural", pinned: true, updatedAt: "2026-05-18T00:00:00.000Z" }),
        ],
      })),
      read: vi.fn(),
      search: vi.fn(),
    }
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { memory } = await import("../src/capabilities.ts")

    const capabilities = await resolveAgentCapabilities({
      capabilities: [
        memory({
          stores: {
            agent: {
              adapter,
              read: { preload: [{ kind: "procedural", maxItems: 1, pinned: true }] },
              scope: { agent: "support" },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, {})

    const preload = capabilities.capabilityInstructions.find(block => block.id === "memory.agent")
    expect(preload?.instructions).toContain("New workflow.")
    expect(preload?.instructions).not.toContain("Old workflow.")
  })

  it("enforces memory write mode and policy for the selected store", async () => {
    const writable: MemoryStoreAdapter = {
      append: vi.fn(async request => ({ action: "created" as const, item: memoryRecord({ ...request, id: "mem_1" }) })),
      delete: vi.fn(async request => ({ deletedId: request.id, ok: true as const, tombstoneId: "mem_del_1" })),
      export: vi.fn(async () => ({ items: [] })),
      read: vi.fn(),
      search: vi.fn(),
    }
    const readonly: MemoryStoreAdapter = {
      append: vi.fn(),
      delete: vi.fn(),
      export: vi.fn(async () => ({ items: [] })),
      read: vi.fn(),
      search: vi.fn(),
    }
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { memory } = await import("../src/capabilities.ts")
    let capturedTools: Record<string, { execute: (input: unknown) => Promise<unknown> | unknown, policy?: (context: { input?: unknown }) => unknown }> = {}
    const agent = defineAgent({
      async run(context) {
        capturedTools = context.tools as typeof capturedTools
        return { text: "ok" }
      },
      capabilities: [
        memory({
          stores: {
            agent: {
              adapter: writable,
              scope: { agent: "support" },
              write: { mode: "tool", policy: "allow" },
            },
            readonly: {
              adapter: readonly,
              scope: { agent: "support" },
            },
          },
        }),
      ],
    })

    await runAgent(agent, runtime(), {})
    expect(await capturedTools.memory_remember!.policy!({ input: { store: "agent" } })).toBe("allow")
    await expect(Promise.resolve().then(() => capturedTools.memory_remember!.execute({ content: "Keep this.", kind: "semantic", store: "readonly" }))).rejects.toThrow("does not allow writes")
    await expect(Promise.resolve().then(() => capturedTools.memory_delete!.execute({ id: "mem_1", store: "readonly" }))).rejects.toThrow("does not allow writes")
    expect(readonly.append).not.toHaveBeenCalled()
    expect(readonly.delete).not.toHaveBeenCalled()
  })

  it("does not expose memory write tools unless at least one store opts in", async () => {
    const adapter: MemoryStoreAdapter = {
      append: vi.fn(),
      delete: vi.fn(),
      export: vi.fn(async () => ({ items: [] })),
      read: vi.fn(),
      search: vi.fn(),
    }
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { memory } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      async run(context) {
        return { text: Object.keys(context.tools || {}).sort().join(",") }
      },
      capabilities: [
        memory({
          stores: {
            agent: {
              adapter,
              scope: { agent: "support" },
            },
          },
        }),
      ],
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      text: "memory_read,memory_search",
    })
  })

  it("persists workspace JSONL memory as append-only events", async () => {
    const files = new Map<string, string>()
    const { workspaceJsonlMemoryStore } = await import("../src/capabilities.ts")
    const adapter = await workspaceJsonlMemoryStore({ path: ".vitehub/memory/test.jsonl" }).create({
      workspace: {
        fs: {
          appendFile: async (path: string, content: string) => files.set(path, `${files.get(path) || ""}${content}`),
          mkdir: vi.fn(),
          readFile: async (path: string) => files.get(path) || "",
          writeFile: vi.fn(),
        },
      },
    } as never)

    const created = await adapter.append({
      content: "Memory is scoped durable context.",
      kind: "semantic",
      scope: { agent: "support" },
      store: "agent",
      title: "Memory definition",
    })
    await expect(adapter.search({ query: "scoped", scope: { agent: "support" }, store: "agent" })).resolves.toMatchObject({
      items: [{ id: created.item.id }],
    })
    await adapter.delete({ id: created.item.id, scope: { agent: "support" }, store: "agent" })
    await expect(adapter.read({ id: created.item.id, scope: { agent: "support" }, store: "agent" })).resolves.toEqual({ item: null })
    expect(files.get(".vitehub/memory/test.jsonl")?.trim().split("\n")).toHaveLength(2)
  })

  it("supersedes old workspace JSONL memory records", async () => {
    const files = new Map<string, string>()
    const { workspaceJsonlMemoryStore } = await import("../src/capabilities.ts")
    const adapter = await workspaceJsonlMemoryStore({ path: ".vitehub/memory/test.jsonl" }).create({
      workspace: {
        fs: {
          appendFile: async (path: string, content: string) => files.set(path, `${files.get(path) || ""}${content}`),
          mkdir: vi.fn(),
          readFile: async (path: string) => files.get(path) || "",
          writeFile: vi.fn(),
        },
      },
    } as never)

    const first = await adapter.append({
      content: "Old workflow.",
      kind: "procedural",
      scope: { agent: "support" },
      store: "agent",
    })
    const second = await adapter.append({
      content: "New workflow.",
      kind: "procedural",
      scope: { agent: "support" },
      store: "agent",
      supersedes: [first.item.id],
    })

    await expect(adapter.search({ query: "workflow", scope: { agent: "support" }, store: "agent" })).resolves.toMatchObject({
      items: [{ id: second.item.id }],
    })
    await expect(adapter.read({ id: first.item.id, scope: { agent: "support" }, store: "agent" })).resolves.toEqual({ item: null })
    expect(files.get(".vitehub/memory/test.jsonl")?.trim().split("\n")).toHaveLength(3)
  })
})
