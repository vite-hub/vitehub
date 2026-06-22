import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ReadonlyWorkspaceFacade, WritableWorkspaceFacade } from "@vite-hub/workspace"

const readFile = vi.fn()
const writeFile = vi.fn()
const list = vi.fn()
const exists = vi.fn()
const diff = vi.fn()
const snapshot = vi.fn()
const tools = vi.fn(() => ({}))
const inspectTools = vi.fn(() => ({}))
const createWorkspaceTools = vi.fn(() => ({}))
const createWorkspaceSourceResolutionFacade = vi.fn(async (workspace: ReadonlyWorkspaceFacade | WritableWorkspaceFacade, definition: unknown) => ({ definition, workspace }))
const getWorkspaceSourceRequestDescriptor = vi.fn((_: unknown): { method: string, url: string } | undefined => undefined)
const isWorkspaceSourceRequestOnly = vi.fn((_: unknown): boolean => false)
const resolveWorkspaceAutoCommit = vi.fn()
const workspaceSourceRequestDescriptorPath = vi.fn((source: string) => `.vitehub/sources/${source}.json`)
const useWorkspace = vi.fn<() => ReadonlyWorkspaceFacade | WritableWorkspaceFacade>(() => ({
  diff,
  fs: { exists, list, readFile, writeFile },
  snapshot,
  tools: Object.assign(tools, {
    inspect: inspectTools,
    none: vi.fn(() => ({})),
    readonly: inspectTools,
  }),
} as unknown as WritableWorkspaceFacade))
const agentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const generateText = vi.hoisted(() => vi.fn())
const agentGenerate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ finishReason: string, steps?: unknown[], text: string }>>(async () => ({ finishReason: "stop", text: "ok" })))
const agentStream = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ fullStream: AsyncIterable<unknown> }>>(async () => ({
  fullStream: (async function* () {
    yield { text: "ok", type: "text-delta" }
  })(),
})))
const harnessAgentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const harnessSandboxSession = vi.hoisted(() => ({
  readBinaryFile: vi.fn(),
  run: vi.fn(),
  writeBinaryFile: vi.fn(),
}))
const harnessCreateSession = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ destroy: () => unknown }>>(async () => ({ destroy: vi.fn() })))
const harnessGenerate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ finishReason: string, text: string }>>(async () => ({ finishReason: "stop", text: "ok" })))
const harnessStream = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ fullStream: AsyncIterable<unknown> }>>(async () => ({
  fullStream: (async function* () {
    yield { text: "ok", type: "text-delta" }
  })(),
})))
const prepareHarnessWorkspaceSession = vi.fn()

vi.mock("ai", () => ({
  generateText,
  jsonSchema: vi.fn(schema => schema),
  stepCountIs: vi.fn(count => ({ count })),
  ToolLoopAgent: class {
    constructor(public settings: Record<string, unknown>) {
      agentSettings.push(settings)
    }

    async generate(...args: unknown[]) {
      return await agentGenerate.apply(this, args)
    }

    async stream(...args: unknown[]) {
      return await agentStream.apply(this, args)
    }
  },
}))

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(public settings: Record<string, unknown>) {
      harnessAgentSettings.push(settings)
    }

    async createSession(...args: unknown[]) {
      const session = await harnessCreateSession.apply(this, args)
      const options = args[0] as { abortSignal?: AbortSignal } | undefined
      await (this.settings.onSandboxSession as ((input: Record<string, unknown>) => Promise<void>) | undefined)?.({
        abortSignal: options?.abortSignal,
        session: harnessSandboxSession,
        sessionWorkDir: "/workspace/codex-session",
      })
      return session
    }

    async generate(...args: unknown[]) {
      return await harnessGenerate.apply(this, args)
    }

    async stream(...args: unknown[]) {
      return await harnessStream.apply(this, args)
    }
  },
}))

vi.mock("@vite-hub/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/workspace")>()
  return {
    ...actual,
    createWorkspaceSourceResolutionFacade,
    createWorkspaceTools,
    getWorkspaceSourceRequestDescriptor,
    isWorkspaceSourceRequestOnly,
    prepareHarnessWorkspaceSession,
    resolveWorkspaceAutoCommit,
    workspaceSourceRequestDescriptorPath,
    useWorkspace,
  }
})

const { withAgentDefaults } = await import("../src/index.ts")

function context(runtimeConfig: Record<string, unknown> = {}) {
  return {
    input: { messages: [] },
    memo: (_key: string, create: () => unknown) => create(),
    runtime: "vite",
    runtimeConfig,
    waitUntil: vi.fn(),
  } as never
}

function readonlyWorkspaceFacade(): ReadonlyWorkspaceFacade {
  return {
    fs: { exists, list, readFile },
    tools: Object.assign(vi.fn(() => ({})), {
      inspect: inspectTools,
      none: vi.fn(() => ({})),
      readonly: inspectTools,
    }),
  } as unknown as ReadonlyWorkspaceFacade
}

describe("defineAgent workspace option", () => {
  beforeEach(() => {
    agentSettings.length = 0
    harnessAgentSettings.length = 0
    harnessCreateSession.mockReset()
    harnessCreateSession.mockResolvedValue({ destroy: vi.fn() })
    harnessGenerate.mockReset()
    harnessGenerate.mockResolvedValue({ finishReason: "stop", text: "ok" })
    harnessStream.mockReset()
    harnessStream.mockResolvedValue({
      fullStream: (async function* () {
        yield { text: "ok", type: "text-delta" }
      })(),
    })
    harnessSandboxSession.readBinaryFile.mockReset()
    harnessSandboxSession.run.mockReset()
    harnessSandboxSession.writeBinaryFile.mockReset()
    prepareHarnessWorkspaceSession.mockReset()
    agentGenerate.mockReset()
    agentGenerate.mockResolvedValue({ finishReason: "stop", text: "ok" })
    agentStream.mockReset()
    agentStream.mockResolvedValue({
      fullStream: (async function* () {
        yield { text: "ok", type: "text-delta" }
      })(),
    })
    generateText.mockReset()
    generateText.mockResolvedValue({ text: "fallback answer" })
    exists.mockReset()
    exists.mockResolvedValue(false)
    diff.mockReset()
    diff.mockResolvedValue({ entries: [], to: "next" })
    list.mockReset()
    list.mockResolvedValue([])
    readFile.mockReset()
    writeFile.mockReset()
    snapshot.mockReset()
    resolveWorkspaceAutoCommit.mockReset()
    resolveWorkspaceAutoCommit.mockReturnValue(undefined)
    tools.mockClear()
    inspectTools.mockReset()
    inspectTools.mockReturnValue({})
    createWorkspaceTools.mockReset()
    createWorkspaceTools.mockReturnValue({})
    createWorkspaceSourceResolutionFacade.mockClear()
    createWorkspaceSourceResolutionFacade.mockImplementation(async (workspace, definition) => ({ definition, workspace }))
    getWorkspaceSourceRequestDescriptor.mockReset()
    getWorkspaceSourceRequestDescriptor.mockReturnValue(undefined)
    isWorkspaceSourceRequestOnly.mockReset()
    isWorkspaceSourceRequestOnly.mockReturnValue(false)
    useWorkspace.mockClear()
    workspaceSourceRequestDescriptorPath.mockReset()
    workspaceSourceRequestDescriptorPath.mockImplementation((source: string) => `.vitehub/sources/${source}.json`)
  })

  it("fails when a capability-required workspace path is missing", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [skills({ path: "agent-skills/support" })],
      model: {} as never,
      workspace: {},
    })

    await expect(agent.run!(context())).rejects.toThrow("skills() requires workspace path agent-skills/support/SKILL.md")
    expect(exists).toHaveBeenCalledWith("agent-skills/support/SKILL.md")
  })

  it("checks custom capability workspace path requirements", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      capabilities: [{
        id: "docs",
        requires: [{ primitive: "workspace", workspace: { paths: ["CONTEXT.md"], required: true } }],
      }],
      model: {} as never,
      workspace: {},
    })

    await expect(agent.run!(context())).rejects.toThrow("docs() requires workspace path CONTEXT.md")
    expect(exists).toHaveBeenCalledWith("CONTEXT.md")
  })

  it("accepts skills() when SKILL.md exists", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")
    exists.mockResolvedValue(true)

    const agent = defineAgent({
      capabilities: [skills({ path: "agent-skills/support" })],
      model: {} as never,
      workspace: {},
    })

    await expect(agent.run!(context())).resolves.toBe("ok")
  })

  it("records opt-in skill shell execution mode", async () => {
    const { skills } = await import("../src/capabilities.ts")

    expect(skills().metadata).not.toHaveProperty("shellExecution")
    expect(skills({ shellExecution: "read" }).metadata).toMatchObject({ shellExecution: "read" })
    expect(skills({ shellExecution: "write" }).metadata).toMatchObject({ shellExecution: "write" })
    expect(() => skills({ shellExecution: "execute" as never })).toThrow("skills({ shellExecution })")
  })

  it("requires writable workspace for write-mode skill shell execution", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [skills({ path: "agent-skills/support", shellExecution: "write" })],
      model: {} as never,
      workspace: { mode: "read" },
    })

    await expect(agent.run!(context())).rejects.toThrow("skills() requires workspace.mode: \"write\"")
  })

  it("requires writable workspace for git commands", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { git } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [git()],
      model: {} as never,
      workspace: { mode: "read" },
    })

    await expect(agent.run!(context())).rejects.toThrow("git() requires workspace.mode: \"write\"")
  })

  it("creates a workspace and agent definition without resolving workspace until run", async () => {
    const { useWorkspace } = await import("@vite-hub/workspace")
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      workspace: {
        sources: {},
      },
      description: "Answer from workspace context",
      model: {} as never,
    })

    expect(agent.description).toBe("Answer from workspace context")
    expect(agent.sources).toEqual({})
    expect(useWorkspace).not.toHaveBeenCalled()
  })

  it("rejects unknown colocated Workspace Definition options", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expect(() => defineAgent({
      model: {} as never,
      workspace: {
        stroe: { provider: "memory" },
      } as never,
    })).toThrow("[vitehub] defineWorkspace does not support option: stroe.")
  })

  it("prepares Harness Workspace Sessions for workspace-backed harness Agent Drivers", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const harnessSession = { destroy: vi.fn() }
    const harnessWorkspaceSession = { close: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(harnessSession)
    prepareHarnessWorkspaceSession.mockResolvedValueOnce(harnessWorkspaceSession)
    exists.mockResolvedValue(true)

    const agent = withAgentDefaults(defineAgent({
      driver: {
        harness: { provider: "codex" },
        sandbox: { provider: "sandbox" },
      },
      workspace: {
        sources: {
          guide: {
            instructions: "Use this guide for operating rules.",
            path: "AGENTS.md",
          },
        },
      },
    }), { workspace: "docs" })

    await expect(runAgent(agent, context(), { prompt: "hello" })).resolves.toMatchObject({
      finishReason: "stop",
      text: "ok",
    })

    expect(useWorkspace).toHaveBeenCalledWith("docs")
    expect(prepareHarnessWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), {
      abortSignal: undefined,
      session: harnessSandboxSession,
      sessionWorkDir: "/workspace/codex-session",
    })
    expect(harnessAgentSettings.at(-1)).toMatchObject({
      harness: { provider: "codex" },
      permissionMode: "allow-all",
      sandbox: { provider: "sandbox" },
    })
    expect(harnessGenerate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "hello",
      session: harnessSession,
    }))
    expect(harnessWorkspaceSession.close).toHaveBeenCalledWith(undefined)
    expect(harnessSession.destroy).toHaveBeenCalledOnce()
  })

  it("auto-commits write-mode workspace changes when rules request it", async () => {
    diff.mockResolvedValueOnce({
      entries: [{ after: { type: "file" }, path: "inbox/audio.md", type: "added" }],
      to: "next",
    })
    resolveWorkspaceAutoCommit.mockReturnValueOnce({
      message: "chore: archive audio",
      paths: ["inbox/audio.md"],
    })
    const { defineAgent, runAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        mode: "write",
        rules: {
          "inbox/**": { commit: "chore: archive audio", write: true },
        },
      },
      run: async ({ workspace }) => {
        await (workspace as WritableWorkspaceFacade).fs.writeFile("inbox/audio.md", "transcript")
        return "ok"
      },
    }), { workspace: "docs" })

    await expect(runAgent(agent, context(), { messages: [] })).resolves.toBe("ok")

    expect(useWorkspace).toHaveBeenCalledWith("docs", { mode: "write" })
    expect(resolveWorkspaceAutoCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "docs",
        rules: { "inbox/**": { commit: "chore: archive audio", write: true } },
      }),
      expect.objectContaining({ entries: [expect.objectContaining({ path: "inbox/audio.md" })] }),
    )
    expect(snapshot).toHaveBeenCalledWith({ name: "chore: archive audio" })
  })

  it("auto-commits write-mode workspace changes after raw stream results are consumed", async () => {
    diff.mockResolvedValueOnce({
      entries: [{ after: { type: "file" }, path: "inbox/stream.md", type: "added" }],
      to: "next",
    })
    resolveWorkspaceAutoCommit.mockReturnValueOnce({
      message: "chore: archive stream",
      paths: ["inbox/stream.md"],
    })
    const { defineAgent, streamAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        mode: "write",
        rules: {
          "inbox/**": { commit: "chore: archive stream", write: true },
        },
      },
      run: async ({ workspace }) => {
        await (workspace as WritableWorkspaceFacade).fs.writeFile("inbox/stream.md", "transcript")
        return (async function* () {
          yield { text: "ok", type: "text-delta" }
        })()
      },
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] }) as AsyncIterable<unknown>
    expect(snapshot).not.toHaveBeenCalled()
    for await (const _event of stream) {}

    expect(snapshot).toHaveBeenCalledWith({ name: "chore: archive stream" })
  })

  it("auto-commits write-mode workspace changes after raw Response bodies are consumed", async () => {
    diff.mockResolvedValueOnce({
      entries: [{ after: { type: "file" }, path: "inbox/response.md", type: "added" }],
      to: "next",
    })
    resolveWorkspaceAutoCommit.mockReturnValueOnce({
      message: "chore: archive response",
      paths: ["inbox/response.md"],
    })
    const { defineAgent, runAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        mode: "write",
        rules: {
          "inbox/**": { commit: "chore: archive response", write: true },
        },
      },
      run: async ({ workspace }) => {
        await (workspace as WritableWorkspaceFacade).fs.writeFile("inbox/response.md", "transcript")
        return new Response("ok")
      },
    }), { workspace: "docs" })

    const response = await runAgent(agent, context(), { messages: [] }) as Response
    expect(snapshot).not.toHaveBeenCalled()
    await expect(response.text()).resolves.toBe("ok")

    expect(snapshot).toHaveBeenCalledWith({ name: "chore: archive response" })
  })

  it("uses string instructions", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      instructions: "Use workspace sources.",
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("Use workspace sources.")
  })

  it("rebinds synthetic workspace runs when applying discovered defaults", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(useWorkspace).toHaveBeenCalledWith("docs")
  })

  it("marks synthetic workspace runs with the shared runtime symbol", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      workspace: {},
      model: {} as never,
    })

    expect(agent.run && Symbol.for("vitehub.syntheticWorkspaceRun") in agent.run).toBe(true)
  })

  it("joins array instructions", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      instructions: [" First ", "", "Second"],
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("First\n\nSecond")
  })

  it("joins mixed static and callback instructions", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      instructions: [
        "Use workspace sources.",
        async ({ fs }) => await fs.readFile("AGENTS.md"),
      ],
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Use workspace sources.\n\nWorkspace instructions")
  })

  it("uses callback instructions with workspace fs", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      instructions: async ({ fs }) => await fs.readFile("AGENTS.md"),
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Workspace instructions")
  })

  it("appends visible source instructions by default", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          docs: { instructions: "Use docs for product behavior.", name: "docs" } as never,
          raw: { name: "raw" } as never,
        },
      },
      instructions: "Answer from the workspace.",
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe([
      "Answer from the workspace.",
      "## Workspace Sources",
      "### docs\n\nUse docs for product behavior.",
    ].join("\n\n"))
  })

  it("applies model Agent Driver instructions and execution settings", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const model = { id: "driver-model" }

    const agent = withAgentDefaults(defineAgent({
      driver: {
        execution: {
          callSettings: {
            temperature: 0.3,
          },
          stepLimit: 4,
        },
        instructions: "Answer from the driver.",
        model: model as never,
      },
      workspace: {
        sources: {
          docs: { instructions: "Use docs for product behavior.", name: "docs" } as never,
        },
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)).toMatchObject({
      instructions: [
        "Answer from the driver.",
        "## Workspace Sources",
        "### docs\n\nUse docs for product behavior.",
      ].join("\n\n"),
      model,
      stopWhen: { count: 4 },
      temperature: 0.3,
    })
  })

  it("places source instructions in the workspace sources slot", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          docs: {
            instructions: [
              "Use docs first.",
              "Say when docs do not contain the answer.",
            ],
            name: "docs",
          } as never,
        },
      },
      instructions: [
        "Answer from the workspace.",
        "{{ workspace.sources }}",
        "Keep replies short.",
      ],
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe([
      "Answer from the workspace.",
      "## Workspace Sources",
      "### docs\n\nUse docs first.\n\nSay when docs do not contain the answer.",
      "Keep replies short.",
    ].join("\n\n"))
  })

  it("replaces the workspace sources slot with empty instructions when no source instructions are visible", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          docs: { name: "docs" } as never,
        },
      },
      instructions: [
        "Answer from the workspace.",
        "{{ workspace.sources }}",
        "Keep replies short.",
      ],
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("Answer from the workspace.\n\nKeep replies short.")
  })

  it("places Workspace Shell request descriptor hints through the camel-case capability slot", async () => {
    list.mockImplementation(async path => path === ".vitehub/sources"
      ? [{ path: ".vitehub/sources/inventoryHealthSummary.json", type: "file" }]
      : [])
    const { defineAgent } = await import("../src/index.ts")
    const { workspaceShell } = await import("../src/capabilities.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      capabilities: [workspaceShell()],
      instructions: [
        "Answer from the workspace.",
        "{{ capabilities.workspaceShell }}",
        "Keep replies short.",
      ],
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe([
      "Answer from the workspace.",
      [
        "API-backed Sources you can inspect with curl:",
        "- inventoryHealthSummary: read `.vitehub/sources/inventoryHealthSummary.json` before using curl.",
        "Use normal curl syntax that matches the descriptor.",
      ].join("\n"),
      "Keep replies short.",
    ].join("\n\n"))
  })

  it("filters source instructions through Access-scoped workspace visibility", async () => {
    exists.mockResolvedValue(true)
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    const { defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          private: { instructions: "Use private source.", name: "private" } as never,
          public: { instructions: "Use public source.", name: "public" } as never,
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "public",
            scopes: {
              public: { source: "public" },
            },
          },
        }),
      ],
      instructions: "Answer from the workspace.",
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe([
      "Answer from the workspace.",
      "## Workspace Sources",
      "### public\n\nUse public source.",
    ].join("\n\n"))
  })

  it("omits root-mounted source instructions when only another scoped source is visible", async () => {
    exists.mockImplementation(async path => path === "public")
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    const { defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          guide: {
            getKeys: vi.fn(async () => ["AGENTS.md"]),
            instructions: "Use private guide.",
            mount: "",
            name: "file",
          } as never,
          public: { instructions: "Use public source.", mount: "public", name: "public" } as never,
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "public",
            scopes: {
              public: { source: "public" },
            },
          },
        }),
      ],
      instructions: "Answer from the workspace.",
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe([
      "Answer from the workspace.",
      "## Workspace Sources",
      "### public\n\nUse public source.",
    ].join("\n\n"))
  })

  it("does not expose request-only source instructions through a visible workspace root", async () => {
    const privateSource = {
      async getKeys() {
        return []
      },
      async getItem(key: string) {
        return { key, path: key, content: "" }
      },
      instructions: "Use private API.",
      mount: "",
    }
    getWorkspaceSourceRequestDescriptor.mockImplementation(source => source === privateSource ? { method: "GET", url: "https://private.example.com/api" } : undefined)
    isWorkspaceSourceRequestOnly.mockImplementation(source => source === privateSource)
    exists.mockImplementation(async path => path === "" || path === "public")
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    const { defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          private: privateSource as never,
          public: { instructions: "Use public source.", mount: "public", name: "public" } as never,
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "public",
            scopes: {
              public: { source: "public" },
            },
          },
        }),
      ],
      instructions: "Answer from the workspace.",
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe([
      "Answer from the workspace.",
      "## Workspace Sources",
      "### public\n\nUse public source.",
    ].join("\n\n"))
  })

  it("includes root-mounted source instructions when a source path is visible", async () => {
    exists.mockImplementation(async path => path === "AGENTS.md")
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    const { defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          guide: {
            getKeys: vi.fn(async () => ["AGENTS.md"]),
            instructions: "Use support guide.",
            mount: "",
            name: "file",
          } as never,
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "support",
            scopes: {
              support: { path: "AGENTS.md" },
            },
          },
        }),
      ],
      instructions: "Answer from the workspace.",
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe([
      "Answer from the workspace.",
      "## Workspace Sources",
      "### guide\n\nUse support guide.",
    ].join("\n\n"))
  })

  it("synthesizes an answer when tool loop stops without text after tool results", async () => {
    const { defineAgent } = await import("../src/index.ts")
    agentGenerate.mockResolvedValueOnce({
      finishReason: "stop",
      steps: [
        {
          content: [
            { output: { stdout: "client.py:7: posthog_client = Posthog()" }, type: "tool-result" },
          ],
        },
      ],
      text: "",
    })

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    await expect(agent.run!(context())).resolves.toBe("fallback answer")
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("client.py:7"),
    }))
  })

  it("synthesizes streamed answers when tool loops stop without text after AI SDK tool outputs", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield {
          output: { stdout: "client.py:7: posthog_client = Posthog()" },
          toolCallId: "call-1",
          type: "tool-output-available",
        }
      })(),
    })

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("client.py:7"),
    }))
  })

  it("emits streamed workspace fallback text before finish events", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield {
          output: { stdout: "client.py:7: posthog_client = Posthog()" },
          toolCallId: "call-1",
          type: "tool-output-available",
        }
        yield { finishReason: "stop", type: "finish" }
      })(),
    })

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { error: undefined, id: "call-1", name: "tool", output: { stdout: "client.py:7: posthog_client = Posthog()" }, type: "tool-result" },
      { id: "workspace-fallback", text: "fallback answer", type: "text-delta" },
      { reason: "workspace-fallback", type: "finish" },
    ])
  })

  it("emits streamed workspace fallback text before abort events", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield {
          output: { stdout: "client.py:7: posthog_client = Posthog()" },
          toolCallId: "call-1",
          type: "tool-output-available",
        }
        yield { reason: "The operation was aborted due to timeout", type: "abort" }
      })(),
    })

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { error: undefined, id: "call-1", name: "tool", output: { stdout: "client.py:7: posthog_client = Posthog()" }, type: "tool-result" },
      { id: "workspace-fallback", text: "fallback answer", type: "text-delta" },
      { reason: "workspace-fallback", type: "finish" },
    ])
  })

  it("preserves stream result methods when wrapping workspace fallback streams", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    class StreamResult {
      fullStream = (async function* () {
        yield {
          output: { stdout: "client.py:7: posthog_client = Posthog()" },
          toolCallId: "call-1",
          type: "tool-output-available",
        }
        yield { finishReason: "stop", type: "finish" }
      })()

      toUIMessageStream() {
        const lockedBranch = (this.fullStream as unknown as ReadableStream<unknown>).getReader()
        void lockedBranch
        return (this.fullStream as unknown as ReadableStream<unknown>).pipeThrough(new TransformStream({
          transform(part: unknown, controller) {
            if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text-delta" && typeof (part as { id?: unknown }).id !== "string") {
              throw new Error("AI SDK text deltas require an id")
            }
            controller.enqueue(part)
          },
        }))
      }
    }
    agentStream.mockResolvedValueOnce(new StreamResult())

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] }, { output: "ui-message-stream" }) as ReadableStream<unknown>
    const messages: unknown[] = []
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      messages.push(value)
    }

    expect(messages).toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
  })

  it("passes AI SDK tool loop settings through workspace agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const stopWhen = { custom: true }
    const onStepFinish = vi.fn()
    const experimental_telemetry = { integrations: [], isEnabled: true }

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      modelExecution: {
        callSettings: {
          experimental_telemetry: experimental_telemetry as never,
          maxOutputTokens: 100,
          onStepFinish,
          stopWhen: stopWhen as never,
          temperature: 0.2,
          toolChoice: "auto",
        },
      },
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)).toMatchObject({
      experimental_telemetry,
      maxOutputTokens: 100,
      onStepFinish,
      stopWhen,
      temperature: 0.2,
      toolChoice: "auto",
    })
  })

  it("passes provider-defined capability tools to AI SDK agents", async () => {
    const { webSearch } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      capabilities: [webSearch({ mode: "model" })],
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.tools).toMatchObject({
      web_search: {
        args: {},
        id: "openai.web_search",
        name: "web_search",
        type: "provider-defined",
      },
    })
  })

  it("uses custom run for workspace agents on the streaming path", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const stream = (async function* () {
      yield { text: "ok", type: "text-delta" }
    })()
    const run = vi.fn(async () => stream)
    const agent = withAgentDefaults(defineAgent({
      run,
      workspace: {},
    }), { workspace: "docs" })

    await expect(streamAgent(agent as never, context(), { messages: [] })).resolves.toBe(stream)
    expect(run).toHaveBeenCalled()
  })

  it("wraps workspace agent models with runtime instrumentation", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const baseModel = { id: "base" }
    const wrappedModel = { id: "wrapped" }
    const instrumentModel = vi.fn(() => wrappedModel as never)

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      modelExecution: {
        callSettings: {
          onStepFinish: vi.fn(),
        },
        instrumentation: {
          model: instrumentModel,
        },
      },
      model: baseModel as never,
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      run: {
        origin: "telegram",
        runId: "run_123",
        threadId: "thread_1",
      },
    } as never)

    expect(instrumentModel).toHaveBeenCalledWith(expect.objectContaining({
      model: baseModel,
      run: expect.objectContaining({ runId: "run_123" }),
    }))
    expect(agentSettings.at(-1)).toMatchObject({
      model: wrappedModel,
      onStepFinish: expect.any(Function),
    })
    expect(agentSettings.at(-1)).not.toHaveProperty("modelExecution")
  })

  it("lets workspace agents instrument AI SDK call settings per run", async () => {
    const execute = vi.fn(async () => "workspace result")
    const instrumentCallSettings = vi.fn(({ callSettings }) => ({
      experimental_telemetry: { isEnabled: true, runScoped: true },
      temperature: callSettings.temperature,
    }))
    inspectTools.mockReturnValueOnce({
      shell: { execute },
    })
    const { defineAgent } = await import("../src/index.ts")
    const model = { id: "base" }

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      modelExecution: {
        callSettings: {
          temperature: 0.2,
        },
        instrumentation: {
          callSettings: instrumentCallSettings,
        },
        stepLimit: 7,
      },
      model: model as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      input: { messages: [] },
      run: {
        origin: "teams",
        runId: "run_123",
        threadId: "thread_1",
      },
    } as never)

    expect(instrumentCallSettings).toHaveBeenCalledWith(expect.objectContaining({
      input: { messages: [] },
      model,
      run: expect.objectContaining({ origin: "teams", runId: "run_123" }),
      callSettings: expect.objectContaining({ temperature: 0.2 }),
      tools: expect.objectContaining({ shell: expect.any(Object) }),
    }))
    expect(instrumentCallSettings.mock.calls[0]?.[0].callSettings).not.toHaveProperty("stepLimit")
    expect(agentSettings.at(-1)).toMatchObject({
      experimental_telemetry: { isEnabled: true, runScoped: true },
      stopWhen: { count: 7 },
      temperature: 0.2,
    })
    expect(agentSettings.at(-1)).not.toHaveProperty("modelExecution")
  })

  it("isolates call settings instrumentation from definition-owned settings", async () => {
    const observedTemperatures: unknown[] = []
    const instrumentCallSettings = vi.fn(({ callSettings }) => {
      observedTemperatures.push(callSettings.temperature)
      ;(callSettings as Record<string, unknown>).temperature = 0.8
    })
    const { defineAgent } = await import("../src/index.ts")
    const settingsStart = agentSettings.length

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      modelExecution: {
        callSettings: {
          temperature: 0.2,
        },
        instrumentation: {
          callSettings: instrumentCallSettings,
        },
      },
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())
    await agent.run!(context())

    expect(observedTemperatures).toEqual([0.2, 0.2])
    expect(agentSettings.slice(settingsStart)).toEqual([
      expect.objectContaining({ temperature: 0.2 }),
      expect.objectContaining({ temperature: 0.2 }),
    ])
  })

  it("passes runtime context to run-aware step and tool callbacks", async () => {
    const onStepFinish = vi.fn()
    const onRunStepFinish = vi.fn()
    const experimental_onToolCallStart = vi.fn()
    const experimental_onToolCallFinish = vi.fn()
    const onRunToolCallStart = vi.fn()
    const onRunToolCallFinish = vi.fn()
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      modelExecution: {
        callSettings: {
          experimental_onToolCallFinish: experimental_onToolCallFinish as never,
          experimental_onToolCallStart: experimental_onToolCallStart as never,
          onRunStepFinish,
          onRunToolCallFinish,
          onRunToolCallStart,
          onStepFinish,
        },
      },
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      input: { messages: [] },
      run: { runId: "run_123" },
    } as never)

    const settings = agentSettings.at(-1)!
    await (settings.onStepFinish as (step: unknown) => Promise<void>)({ stepNumber: 1 })
    await (settings.experimental_onToolCallStart as (event: unknown) => Promise<void>)({ toolName: "shell" })
    await (settings.experimental_onToolCallFinish as (event: unknown) => Promise<void>)({ durationMs: 12, toolName: "shell" })

    expect(onStepFinish).toHaveBeenCalledWith({ stepNumber: 1 })
    expect(onRunStepFinish).toHaveBeenCalledWith({ stepNumber: 1 }, expect.objectContaining({
      run: { runId: "run_123" },
    }))
    expect(experimental_onToolCallStart).toHaveBeenCalledWith({ toolName: "shell" })
    expect(onRunToolCallStart).toHaveBeenCalledWith({ toolName: "shell" }, expect.objectContaining({
      run: { runId: "run_123" },
    }))
    expect(experimental_onToolCallFinish).toHaveBeenCalledWith({ durationMs: 12, toolName: "shell" })
    expect(onRunToolCallFinish).toHaveBeenCalledWith({ durationMs: 12, toolName: "shell" }, expect.objectContaining({
      run: { runId: "run_123" },
    }))
  })

  it("passes workspace to callback instructions", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      instructions: ({ fs, workspace }) => {
        expect(fs).toBe(workspace.fs)
        return "workspace instructions"
      },
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context({ vertex: { model: "gemini" } }))

    expect(agentSettings.at(-1)?.instructions).toBe("workspace instructions")
  })

  it("does not load AGENTS.md as implicit instructions", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).not.toHaveBeenCalled()
    expect(agentSettings.at(-1)?.instructions).toBe("")
  })

  it("throws when explicit callback instructions fail", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"))
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      instructions: ({ fs }) => fs.readFile("MISSING.md"),
      model: {} as never,
    }), { workspace: "docs" })

    await expect(agent.run!(context())).rejects.toThrow("missing")
  })

  it("does not attach workspace tools unless explicitly requested", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(tools).not.toHaveBeenCalled()
    expect(inspectTools).not.toHaveBeenCalled()
    expect(agentSettings.at(-1)).not.toHaveProperty("tools")
  })

  it("passes workspace facade to workspace tool resolvers", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const shell = { execute: vi.fn(), inputSchema: {} }
    const toolResolver = vi.fn(({ workspace }) => {
      expect(workspace.fs).toEqual(expect.objectContaining({ readFile }))
      return { shell }
    })

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
      capabilities: [{ id: "workspace-tools", tools: toolResolver as never }],
    }), { workspace: "docs" })

    await agent.run!(context({ vertex: { model: "gemini" } }))

    expect(toolResolver).toHaveBeenCalledTimes(1)
    expect(agentSettings.at(-1)?.tools).toEqual({ shell })
  })

  it("reports explicitly attached workspace tool usage when execution starts and finishes", async () => {
    const execute = vi.fn(async () => "workspace result")
    const reportToolStep = vi.fn()
    inspectTools.mockReturnValueOnce({
      shell: {
        execute,
      },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      await this.settings.tools.shell.execute({ command: "rg defineAgent" })
      return { finishReason: "stop", text: "ok" }
    })
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      devtools: { reportToolStep },
    } as never)

    expect(execute).toHaveBeenCalledWith({ command: "rg defineAgent" })
    expect(reportToolStep).toHaveBeenCalledTimes(2)
    expect(reportToolStep.mock.calls[0]?.[0]).toMatchObject({
      toolCalls: [{ input: { command: "rg defineAgent" }, toolName: "shell" }],
    })
    expect(reportToolStep.mock.calls[1]?.[0]).toMatchObject({
      toolResults: [{ output: "workspace result", toolName: "shell" }],
    })
    expect(reportToolStep.mock.calls[0]?.[0].toolCalls[0].toolCallId).toBe(reportToolStep.mock.calls[1]?.[0].toolResults[0].toolCallId)
  })

  it("reports lazy source materialization before model tool usage", async () => {
    const materialize = vi.fn(async () => ({ bytes: 12, directories: 1, durationMs: 3, files: 2, path: "", sources: [{ source: "docs", status: "ready" }] }))
    const shell = vi.fn(async () => "workspace result")
    const reportToolStep = vi.fn()
    inspectTools.mockReturnValueOnce({
      materialize_sources: { execute: materialize },
      shell: { execute: shell },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      await this.settings.tools.shell.execute({ command: "rg PLC forecasting-engine | head -n 20" })
      return { finishReason: "stop", text: "ok" }
    })
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: { sources: { docs: { cache: { maxAge: 60 }, source: {} } as never } },
      model: {} as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      devtools: { reportToolStep },
    } as never)

    expect(materialize).toHaveBeenCalledWith({ path: "" })
    expect(reportToolStep.mock.calls.map(call => Object.keys(call[0])[0])).toEqual([
      "toolCalls",
      "toolResults",
      "toolCalls",
      "toolResults",
    ])
    expect(reportToolStep.mock.calls[0]?.[0]).toMatchObject({
      toolCalls: [{ toolName: "materialize_sources" }],
    })
    expect(reportToolStep.mock.calls[1]?.[0]).toMatchObject({
      toolResults: [{ output: { files: 2, summary: "Materialized docs (2 files)." }, toolName: "materialize_sources" }],
    })
    expect(reportToolStep.mock.calls[2]?.[0]).toMatchObject({
      toolCalls: [{ toolName: "shell" }],
    })
  })

  it("materializes lazy workspace sources without DevTools reporting", async () => {
    const materialize = vi.fn(async () => ({ bytes: 12, directories: 1, durationMs: 3, files: 2, path: "", sources: [{ source: "docs", status: "ready" }] }))
    inspectTools.mockReturnValueOnce({
      materialize_sources: { execute: materialize },
    })
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: { sources: { docs: { cache: { maxAge: 60 }, source: {} } as never } },
      model: {} as never,
      capabilities: [{ id: "bash", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "docs" })

    await expect(agent.run!(context())).resolves.toBe("ok")

    expect(materialize).toHaveBeenCalledWith({ path: "" })
  })

  it("reports materialization errors and continues the model run", async () => {
    const materialize = vi.fn(async () => {
      throw new Error("source unavailable")
    })
    const reportToolStep = vi.fn()
    inspectTools.mockReturnValueOnce({
      materialize_sources: { execute: materialize },
    })
    const { defineAgent } = await import("../src/index.ts")

    const agent = withAgentDefaults(defineAgent({
      workspace: { sources: { docs: { cache: { maxAge: 60 }, source: {} } as never } },
      model: {} as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "docs" })

    await expect(agent.run!({
      ...(context() as Record<string, unknown>),
      devtools: { reportToolStep },
    } as never)).resolves.toBe("ok")

    expect(agentGenerate).toHaveBeenCalledTimes(1)
    expect(reportToolStep.mock.calls[0]?.[0]).toMatchObject({
      toolCalls: [{ toolName: "materialize_sources" }],
    })
    expect(reportToolStep.mock.calls[1]?.[0]).toMatchObject({
      toolErrors: [{ output: "source unavailable", toolName: "materialize_sources" }],
    })
  })

  it("derives DevTools metadata from workspace agents", async () => {
    const { createAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    const model = { modelId: "openai/gpt-test", provider: "openai" }
    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          docs: { name: "docs" } as never,
        },
      },
      instructions: "Answer from the workspace.",
      model: model as never,
      version: "1.2.3",
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(createAgentDevtoolsMetadata(agent)).toEqual({
      config: {
        driver: {
          kind: "model",
          model: {
            id: "openai/gpt-test",
            provider: "openai",
          },
        },
      },
      files: [{
        kind: "directory",
        label: "docs",
        materialize: "build",
        materialized: true,
        path: "docs",
        source: "docs",
        status: "ready",
      }],
      instructions: ["Answer from the workspace."],
      version: "1.2.3",
      tools: expect.arrayContaining([
        expect.objectContaining({
          commands: ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc"],
          category: "workspace",
          name: "workspaceShell",
          status: "available",
        }),
      ]),
    })
  })

  it("adds controlled curl to resolved DevTools metadata when source request descriptors are visible", async () => {
    list.mockImplementation(async path => path === ".vitehub/sources"
      ? [{ path: ".vitehub/sources/inventoryHealthSummary.json", type: "file" }]
      : [])
    const { defineAgent, resolveAgentDevtoolsMetadata } = await import("../src/index.ts")
    const { workspaceShell } = await import("../src/capabilities.ts")
    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
      capabilities: [workspaceShell()],
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent)).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          commands: ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc", "curl"],
          name: "workspaceShell",
        }),
      ]),
    })
  })

  it("resolves dynamic model metadata for DevTools", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    const resolveModel = vi.fn((context: { invoker: { kind?: string } }) => ({
      modelId: `test/${context.invoker.kind || "unknown"}`,
      provider: "test",
    }))
    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      model: resolveModel as never,
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent, {
      input: {
        context: {
          invoker: {
            id: "devtools",
            kind: "devtools",
          },
        },
      },
    })).toMatchObject({
      config: {
        driver: {
          kind: "model",
          model: {
            dynamic: true,
            id: "test/devtools",
            provider: "test",
          },
        },
      },
    })
    expect(resolveModel).toHaveBeenCalledOnce()
  })

  it("marks dynamic DevTools instruction metadata without resolving it", async () => {
    const { createAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    const readInstructions = vi.fn(async () => "Workspace instructions")
    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      instructions: readInstructions,
      model: {} as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(createAgentDevtoolsMetadata(agent).instructions).toEqual(["Dynamic system instructions resolver configured."])
    expect(readInstructions).not.toHaveBeenCalled()
  })

  it("resolves dynamic DevTools instruction metadata", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    const readInstructions = vi.fn(async ({ fs }) => await fs.readFile("AGENTS.md"))
    readFile.mockResolvedValue("# Workspace instructions\n")
    list.mockResolvedValue([{ path: "AGENTS.md", type: "file" }])
    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      instructions: readInstructions,
      model: {} as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent)).toMatchObject({
      files: [{
        kind: "file",
        label: "AGENTS.md",
        path: "AGENTS.md",
      }],
      instructions: ["# Workspace instructions"],
    })
    expect(readInstructions).toHaveBeenCalledOnce()
  })

  it("renders static capability instruction slots in resolved DevTools metadata", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    const readInstructions = vi.fn(async ({ fs }) => await fs.readFile("AGENTS.md"))
    readFile.mockResolvedValue("# Workspace instructions\n\n{{ capabilities.audience }}\n")
    list.mockResolvedValue([{ path: "AGENTS.md", type: "file" }])
    const agent = withAgentDefaults(defineAgent({
      workspace: {},
      instructions: readInstructions,
      model: {} as never,
      capabilities: [{
        id: "audience",
        instructions: "Static audience instructions.",
      }],
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent)).toMatchObject({
      instructions: ["# Workspace instructions\n\nStatic audience instructions."],
    })
    expect(readInstructions).toHaveBeenCalledOnce()
  })

  it("resolves prepare-scoped capability instructions while resolving DevTools metadata", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    const phase = vi.fn()
    const toolResolver = vi.fn(() => ({}))
    const invokerResolve = vi.fn(() => ({ id: "resolved" }))
    exists.mockResolvedValue(true)
    list.mockResolvedValue([{ path: "docs/guide.md", type: "file" }])
    readFile.mockResolvedValue("# Workspace instructions\n\n{{ capabilities.tracked }}")
    const agent = withAgentDefaults(defineAgent({
      invoker: {
        profiles: [{ id: "support", kind: "support", label: "Support" }],
        resolve: invokerResolve,
      },
      workspace: {
        sources: {
          docs: { instructions: "Use docs for support evidence.", name: "docs" } as never,
        },
      },
      instructions: async ({ fs }) => await fs.readFile("AGENTS.md"),
      hooks: {
        "capability:prepare": () => phase("hook:prepare"),
      },
      model: {} as never,
      capabilities: [{
        bind: () => phase("bind"),
        close: () => phase("close"),
        configure: () => phase("configure"),
        id: "tracked",
        input: () => phase("input"),
        instructions: () => {
          phase("instructions")
          return "Dynamic capability instructions."
        },
        output: () => phase("output"),
        prepare: () => phase("prepare"),
        resolve: () => phase("resolve"),
        tools: toolResolver,
      }],
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent, {
      input: { context: { invokerProfileId: "support" } },
    })).toMatchObject({
      files: [expect.objectContaining({ path: "docs" })],
      instructions: [[
        "# Workspace instructions",
        "Dynamic capability instructions.",
        "## Workspace Sources",
        "### docs\n\nUse docs for support evidence.",
      ].join("\n\n")],
      tools: [expect.objectContaining({ name: "tracked" })],
    })
    expect(phase.mock.calls.map(call => call[0])).toEqual(["hook:prepare", "prepare", "instructions"])
    expect(toolResolver).not.toHaveBeenCalled()
    expect(invokerResolve).toHaveBeenCalledOnce()
  })

  it("resolves recursive DevTools file metadata for lazy source entries", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    list.mockResolvedValue([
      { path: "docs/guides", type: "directory" },
      { path: "docs/guides/start.md", type: "file" },
    ])
    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          docs: { cache: { maxAge: 60 }, mount: "docs", name: "docs" } as never,
        },
      },
      instructions: "Answer from the workspace.",
      model: {} as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent)).toMatchObject({
      files: [{
        children: [{
          children: [{
            kind: "file",
            materialize: "lazy",
            materialized: false,
            path: "docs/guides/start.md",
            source: "docs",
          }],
          kind: "directory",
          materialize: "lazy",
          materialized: false,
          path: "docs/guides",
          source: "docs",
        }],
        kind: "directory",
        materialized: true,
        path: "docs",
        source: "docs",
        status: "ready",
      }],
    })
  })

  it("applies Access-scoped workspace visibility during DevTools metadata resolution", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
    const resolveScope = vi.fn(({ invoker }) => {
      return invoker.meta?.scope === "support"
        ? { role: "admin", scope: "support" }
        : { role: "viewer", scope: "customer" }
    })
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    list.mockResolvedValue([
      { path: "customers", type: "directory" },
      { path: "customers/acme", type: "directory" },
      { path: "customers/acme/orders.sql", type: "file" },
      { path: "customers/globex", type: "directory" },
      { path: "customers/globex/orders.sql", type: "file" },
      { path: "portal", type: "directory" },
    ])
    const agent = withAgentDefaults(defineAgent({
      invoker: {
        profiles: [
          { id: "customer", kind: "customer", label: "Customer", meta: { scope: "customer" } },
          { id: "support", kind: "support", label: "Support", meta: { scope: "support" } },
        ],
      },
      workspace: {
        sources: {
          customers: { mount: "customers", name: "customers" } as never,
          portal: { mount: "portal", name: "portal" } as never,
        },
      },
      capabilities: [
        access({
          workspace: {
            resolve: resolveScope,
            scopes: {
              customer: { paths: ["customers/acme"] },
              support: { all: true },
            },
          },
        }),
      ],
      instructions: "Answer from the workspace.",
      model: {} as never,
    }), { workspace: "support" })

    const metadata = await resolveAgentDevtoolsMetadata(agent, {
      input: { context: { invokerProfileId: "customer" } },
    })
    const paths = JSON.stringify(metadata.files)

    expect(paths).toContain("customers/acme/orders.sql")
    expect(paths).not.toContain("customers/globex")
    expect(paths).not.toContain("portal")
    expect(resolveScope).toHaveBeenCalledOnce()
    expect(createWorkspaceSourceResolutionFacade).toHaveBeenCalledOnce()
  })

  it("renders static Source Instructions after Access source resolution for DevTools metadata", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    exists.mockImplementation(async path => path === "ingestion/acme")
    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          ingestion: {
            instructions: "Use this source for ingestion models.",
            mount: "ingestion/acme",
            name: "ingestion",
          } as never,
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { path: "ingestion/acme" },
            },
          },
        }),
      ],
      instructions: "Answer from the workspace.",
      model: {} as never,
    }), { workspace: "support" })

    await expect(resolveAgentDevtoolsMetadata(agent)).resolves.toMatchObject({
      instructions: [[
        "Answer from the workspace.",
        "## Workspace Sources",
        "### ingestion\n\nUse this source for ingestion models.",
      ].join("\n\n")],
    })
    expect(createWorkspaceSourceResolutionFacade).toHaveBeenCalledOnce()
  })

  it("flattens virtual workspace AGENTS.md while keeping sibling instruction files", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    list.mockResolvedValue([
      { path: "forecasting-engine", type: "directory" },
      { path: "ingestion", type: "directory" },
      { path: "instructions", type: "directory" },
      { path: "instructions/AGENTS.md", type: "file" },
      { path: "instructions/private.md", type: "file" },
    ])
    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          "forecasting-engine": { name: "forecasting-engine" } as never,
          ingestion: { name: "ingestion" } as never,
        },
      },
      instructions: "Answer from the workspace.",
      model: {} as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    const metadata = await resolveAgentDevtoolsMetadata(agent)
    expect(metadata.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file", label: "AGENTS.md", path: "AGENTS.md" }),
      expect.objectContaining({ kind: "directory", path: "forecasting-engine" }),
      expect.objectContaining({ kind: "directory", path: "ingestion" }),
    ]))
    expect(metadata.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "directory",
        path: "instructions",
        children: expect.arrayContaining([
          expect.objectContaining({ kind: "file", path: "instructions/private.md" }),
        ]),
      }),
    ]))
  })

  it("marks listed lazy source files as materialized when stored metadata is present", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent } = await import("../src/index.ts")
    list.mockResolvedValue([
      { mtime: 1710000000000, path: "docs/guides/start.md", size: 128, type: "file" },
    ])
    const agent = withAgentDefaults(defineAgent({
      workspace: {
        sources: {
          docs: { cache: { maxAge: 60 }, mount: "docs", name: "docs" } as never,
        },
      },
      instructions: "Answer from the workspace.",
      model: {} as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent)).toMatchObject({
      files: [{
        children: [{
          children: [{
            kind: "file",
            materialized: true,
            materializedAt: "2024-03-09T16:00:00.000Z",
            path: "docs/guides/start.md",
            source: "docs",
          }],
          path: "docs/guides",
        }],
      }],
    })
  })
})
