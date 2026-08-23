import { describe, expect, it, vi } from "vitest"

import { resolveAgentCapabilities } from "../src/capability-runtime.ts"
import { repositoryHost } from "../src/capabilities.ts"

import type { RepositoryHostClient } from "../src/capabilities.ts"

function runtime(capabilities: Record<string, unknown> = {}) {
  return {
    capabilities,
    memo: vi.fn(),
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    runtime: "unknown" as const,
    runtimeConfig: {},
    waitUntil: vi.fn(),
  }
}

async function resolveTools(capability = repositoryHost(), capabilities: Record<string, unknown> = {}) {
  const resolved = await resolveAgentCapabilities({ capabilities: [capability] }, runtime(capabilities), {})
  return resolved.tools!
}

describe("repositoryHost capability", () => {
  it("defaults to read mode and uses a repository-host runtime primitive", () => {
    expect(repositoryHost()).toMatchObject({
      id: "repository-host",
      metadata: { kind: "repository-host", mode: "read" },
      mode: "read",
      requires: [{ primitive: "repository-host" }],
    })
    expect(repositoryHost({ client: { read: vi.fn() }, mode: "write", provider: "github" })).toMatchObject({
      metadata: { mode: "write", provider: "github" },
      mode: "write",
      requires: undefined,
    })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    expect(() => repositoryHost({ mode: "admin" as never })).toThrow("Repository Host mode must be \"read\" or \"write\"")
  })

  it("exposes a normalized read tool", async () => {
    const client: RepositoryHostClient = {
      read: vi.fn(async request => ({ request })),
    }
    const tools = await resolveTools(repositoryHost({ client }))

    expect(Object.keys(tools)).toEqual(["repository_host_read"])
    await expect(tools.repository_host_read!.execute?.({
      operation: "changeRequest",
      target: { id: 12, owner: "vite-hub", repository: "vitehub" },
    })).resolves.toEqual({
      request: {
        operation: "changeRequest",
        target: { id: 12, owner: "vite-hub", repository: "vitehub" },
      },
    })
    expect(client.read).toHaveBeenCalledWith({
      operation: "changeRequest",
      target: { id: 12, owner: "vite-hub", repository: "vitehub" },
    })
    await expect(tools.repository_host_read!.execute?.({
      operation: "changeRequestFiles",
      target: { id: 12, owner: "vite-hub", repository: "vitehub" },
    })).resolves.toMatchObject({
      request: {
        operation: "changeRequestFiles",
      },
    })
  })

  it("uses runtime primitive clients", async () => {
    const client: RepositoryHostClient = {
      read: vi.fn(async () => "ok"),
    }
    const tools = await resolveTools(repositoryHost(), { "repository-host": client })

    await expect(tools.repository_host_read!.execute?.({
      operation: "repository",
      target: { repository: "vitehub" },
    })).resolves.toBe("ok")
  })

  it("exposes writes only in write mode and requires write support", async () => {
    const readOnly: RepositoryHostClient = {
      read: vi.fn(),
    }
    const readTools = await resolveTools(repositoryHost({ client: readOnly }))
    expect(Object.keys(readTools)).toEqual(["repository_host_read"])

    const writeTools = await resolveTools(repositoryHost({ client: readOnly, mode: "write" }))
    expect(Object.keys(writeTools).sort()).toEqual(["repository_host_read", "repository_host_write"])
    expect(writeTools.repository_host_write!.activity).toEqual({ kind: "action", name: "repository-host.write" })
    expect(writeTools.repository_host_write!.policy).toBeUndefined()
    await expect(Promise.resolve().then(() => writeTools.repository_host_write!.execute?.({
      body: "Queued review.",
      operation: "comment",
      target: { id: 12, repository: "vitehub" },
    }))).rejects.toThrow("client to expose write")
  })

  it("validates normalized write requests before calling the client", async () => {
    const client: RepositoryHostClient = {
      read: vi.fn(),
      write: vi.fn(async request => ({ request })),
    }
    const tools = await resolveTools(repositoryHost({ client, mode: "write" }))

    await expect(tools.repository_host_write!.execute?.({
      body: "Looks good.",
      operation: "comment",
      target: { id: "17", kind: "changeRequest", owner: "vite-hub", repository: "vitehub" },
    })).resolves.toEqual({
      request: {
        body: "Looks good.",
        operation: "comment",
        target: { id: "17", kind: "changeRequest", owner: "vite-hub", repository: "vitehub" },
      },
    })
    await expect(Promise.resolve().then(() => tools.repository_host_write!.execute?.({
      operation: "comment",
      target: { id: "17", repository: "vitehub" },
    }))).rejects.toThrow("comment body")
    await expect(Promise.resolve().then(() => tools.repository_host_write!.execute?.({
      body: "Missing id.",
      operation: "comment",
      target: { repository: "vitehub" },
    }))).rejects.toThrow("requires target.id")
  })
})
