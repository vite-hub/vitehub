import { describe, expect, it, vi } from "vitest"
import { defineWorkspace, useWorkspace } from "@vite-hub/workspace"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { resolveAgentCapabilities, workspaceMaterializationPathsSymbol } from "../src/capability-runtime.ts"
import { mcp } from "../src/capabilities/mcp.ts"
import { createAgentEnvIdentity } from "../src/internal/env-identity.ts"
import { getAgentTelemetryConfiguration, setAgentTelemetryConfiguration } from "../src/internal/agent-telemetry.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"

import type { WorkspaceSourceInput } from "@vite-hub/workspace"

const runtime = () => ({
  agentIdentity: createAgentEnvIdentity({ name: "agent" }),
  capabilities: {},
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

/** A fake MCP client that serves tools and `skill://` resources, one list page per array entry. */
function skillServer(pages: string[][], files: Record<string, string> = {}) {
  return {
    close: vi.fn(async () => undefined),
    listResources: vi.fn(async (options?: { params?: { cursor?: string } }) => {
      const index = Number(options?.params?.cursor ?? 0)
      return {
        resources: (pages[index] ?? []).map(uri => ({ name: uri, uri })),
        ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}),
      }
    }),
    readResource: vi.fn(async ({ uri }: { uri: string }) => ({
      contents: uri in files ? [{ mimeType: "text/markdown", text: files[uri], uri }] : [],
    })),
    tools: vi.fn(async () => ({ search: { execute: vi.fn(async () => "ok") } })),
  }
}

async function resolveWithWorkspace(capability: ReturnType<typeof mcp>, sources: Record<string, WorkspaceSourceInput> = {}) {
  const name = `mcp-skills-${crypto.randomUUID()}`
  const definition = defineWorkspace({ store: { provider: "memory" }, sources })
  registerWorkspace(name, definition)
  const workspace = useWorkspace(name, { mode: "write" })
  const context = createAgentInvocationContextStore()
  await setAgentTelemetryConfiguration(context, { capabilities: [{ id: "mcp" }], driver: { kind: "run" }, runtime: { name: "unknown" } })
  const resolved = await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), {}, workspace as never, "write", {
    context,
    driverKind: "provider",
    invocationKind: "run",
    workspaceDefinition: { ...definition, name },
  })
  const inspection = getAgentTelemetryConfiguration(context)?.value.capabilities?.find(item => item.id === "mcp")?.inspection
  // SAFETY: mcp() publishes its inspection state as a list of server records.
  const servers = (inspection?.state as { servers: Array<Record<string, unknown>> } | undefined)?.servers ?? []
  return { resolved, skills: Object.fromEntries(servers.map(server => [server.name, server.skills])), workspace }
}

describe("mcp() Skills", () => {
  it("installs the Skills of every listed page for the Invocation only", async () => {
    const server = skillServer([
      ["skill://drop/SKILL.md", "docs://readme.md"],
      ["skill://drop/references/api.md"],
    ], {
      "skill://drop/SKILL.md": "# Drop",
      "skill://drop/references/api.md": "API",
    })
    const capability = mcp({ servers: { drop: server } })
    const { resolved, skills, workspace } = await resolveWithWorkspace(capability)
    try {
      expect(server.listResources).toHaveBeenCalledTimes(2)
      expect(server.listResources).toHaveBeenLastCalledWith({ params: { cursor: "1" } })
      expect(Object.keys(resolved.tools ?? {})).toEqual(["mcp_drop_search"])
      expect(skills).toEqual({ drop: "drop" })
      await expect(resolved.workspace!.fs.readFile(".agents/skills/drop/SKILL.md")).resolves.toBe("# Drop")
      await expect(resolved.workspace!.fs.readFile(".agents/skills/drop/references/api.md")).resolves.toBe("API")
      expect(Reflect.get(capability, workspaceMaterializationPathsSymbol)).toEqual([".agents/skills"])
    }
    finally {
      await resolved.close()
    }
    await expect(workspace.fs.exists(".agents/skills/drop/SKILL.md")).resolves.toBe(false)
  })

  it("skips invalid names, unsafe paths and Skills without a SKILL.md", async () => {
    const server = skillServer([[
      "skill://Bad_Name/SKILL.md",
      "skill://-leading/SKILL.md",
      "skill://notes/README.md",
      "skill://safe/SKILL.md",
      "skill://safe/../escape.md",
      "skill://safe/./here.md",
      "skill://safe/a//b.md",
      "skill://safe/bad\u0001name.md",
      "skill://safe/back\\slash.md",
      "skill://safe/.git/config",
    ]], {
      "skill://Bad_Name/SKILL.md": "# Bad",
      "skill://-leading/SKILL.md": "# Leading",
      "skill://notes/README.md": "Notes",
      "skill://safe/SKILL.md": "# Safe",
    })
    const { resolved, skills } = await resolveWithWorkspace(mcp({ servers: { docs: server } }))
    try {
      expect(skills).toEqual({ docs: "safe" })
      expect(server.readResource.mock.calls.map(([args]) => args.uri)).toEqual(["skill://safe/SKILL.md"])
      await expect(resolved.workspace!.fs.exists(".agents/skills/notes/README.md")).resolves.toBe(false)
      await expect(resolved.workspace!.fs.readFile(".agents/skills/safe/SKILL.md")).resolves.toBe("# Safe")
    }
    finally {
      await resolved.close()
    }
  })

  it("keeps the Agent's own Skill and the first server's Skill of the same name", async () => {
    const first = skillServer([["skill://review/SKILL.md", "skill://shared/SKILL.md"]], {
      "skill://review/SKILL.md": "# Review from MCP",
      "skill://shared/SKILL.md": "# Shared from first",
    })
    const second = skillServer([["skill://shared/SKILL.md", "skill://extra/SKILL.md"]], {
      "skill://shared/SKILL.md": "# Shared from second",
      "skill://extra/SKILL.md": "# Extra",
    })
    const { resolved } = await resolveWithWorkspace(mcp({ servers: { first, second } }), {
      ownReview: { content: "# Own review", workspacePath: ".agents/skills/review/SKILL.md" },
    })
    try {
      await expect(resolved.workspace!.fs.readFile(".agents/skills/review/SKILL.md")).resolves.toBe("# Own review")
      await expect(resolved.workspace!.fs.readFile(".agents/skills/shared/SKILL.md")).resolves.toBe("# Shared from first")
      await expect(resolved.workspace!.fs.readFile(".agents/skills/extra/SKILL.md")).resolves.toBe("# Extra")
    }
    finally {
      await resolved.close()
    }
  })

  it("does not read Skills from a server with skills: false or pass the option to the MCP client", async () => {
    const created = skillServer([["skill://drop/SKILL.md"]], { "skill://drop/SKILL.md": "# Drop" })
    const createMCPClient = vi.fn(async () => created)
    vi.doMock("@ai-sdk/mcp", () => ({ createMCPClient }))
    try {
      const { resolved, skills } = await resolveWithWorkspace(mcp({
        servers: { drop: { skills: false, transport: { type: "http", url: "https://drop.example.com/mcp" } } },
      }))
      try {
        expect(createMCPClient).toHaveBeenCalledWith(expect.not.objectContaining({ skills: expect.anything() }))
        expect(created.listResources).not.toHaveBeenCalled()
        expect(skills).toEqual({ drop: "Off" })
        expect(Object.keys(resolved.tools ?? {})).toEqual(["mcp_drop_search"])
        await expect(resolved.workspace!.fs.exists(".agents/skills/drop/SKILL.md")).resolves.toBe(false)
      }
      finally {
        await resolved.close()
      }
    }
    finally {
      vi.doUnmock("@ai-sdk/mcp")
    }
  })

  it("keeps the tools when Skills discovery fails", async () => {
    const failing = skillServer([])
    failing.listResources.mockRejectedValue(new Error("resources/list exploded"))
    const unsupported = skillServer([])
    unsupported.listResources.mockRejectedValue(Object.assign(new Error("Server does not support resources"), { name: "MCPClientError" }))
    const { resolved, skills } = await resolveWithWorkspace(mcp({ servers: { failing, unsupported } }))
    try {
      expect(Object.keys(resolved.tools ?? {})).toEqual(["mcp_failing_search", "mcp_unsupported_search"])
      expect(skills).toEqual({ failing: "Discovery failed: resources/list exploded", unsupported: "None" })
    }
    finally {
      await resolved.close()
    }
  })

  it("does not read Skills without a Workspace", async () => {
    const server = skillServer([["skill://drop/SKILL.md"]], { "skill://drop/SKILL.md": "# Drop" })
    const resolved = await resolveAgentCapabilities({ capabilities: [mcp({ servers: { drop: server } })] }, runtime(), {})
    try {
      expect(server.listResources).not.toHaveBeenCalled()
      expect(Object.keys(resolved.tools ?? {})).toEqual(["mcp_drop_search"])
    }
    finally {
      await resolved.close()
    }
  })
})
