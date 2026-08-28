import { mkdir, mkdtemp, rm, writeFile as writeLocalFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { noExecutionAuthority, unknownExecutionAuthority, ViteHubError } from "@vite-hub/runtime"

import type { ReadonlyWorkspaceFacade, WritableWorkspaceFacade, WorkspaceSourceInput } from "@vite-hub/workspace"

const readFile = vi.fn()
const writeFile = vi.fn()
const list = vi.fn()
const exists = vi.fn()
const stat = vi.fn()
const diff = vi.fn()
const rebase = vi.fn()
const snapshot = vi.fn()
const tools = vi.fn(() => ({}))
const inspectTools = vi.fn(() => ({}))
const writeTools = vi.fn(() => ({}))
const createWorkspaceTools = vi.fn(() => ({}))
const createWorkspaceSourceResolutionFacade = vi.fn(async (workspace: ReadonlyWorkspaceFacade | WritableWorkspaceFacade, definition: unknown) => ({ definition, workspace }))
const getWorkspaceSourceRequestDescriptor = vi.fn((_: unknown): { method: string, url: string } | undefined => undefined)
const isWorkspaceSourceRequestOnly = vi.fn((_: unknown): boolean => false)
const resolveRegisteredWorkspaceDefinition = vi.fn()
const resolveWorkspaceAutoCommit = vi.fn()
const workspaceSourceRequestDescriptorPath = vi.fn((source: string) => `.vitehub/sources/${source}.json`)
const tempRoots: string[] = []
const useWorkspace = vi.fn<(name: string, options?: Record<string, unknown>) => ReadonlyWorkspaceFacade | WritableWorkspaceFacade>(() => ({
  diff,
  fs: { exists, list, readFile, stat, writeFile },
  history: { rebase },
  snapshot,
  tools: Object.assign(tools, {
    inspect: inspectTools,
    none: vi.fn(() => ({})),
    readonly: inspectTools,
  }),
} as unknown as WritableWorkspaceFacade))
const agentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const generateText = vi.hoisted(() => vi.fn())
const jsonSchema = vi.hoisted(() => vi.fn(schema => ({ schema, type: "json-schema" })))
const agentGenerate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ finishReason: string, steps?: unknown[], text: string }>>(async () => ({ finishReason: "stop", text: "ok" })))
const agentStream = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ fullStream: AsyncIterable<unknown> }>>(async () => ({
  fullStream: (async function* () {
    yield { text: "ok", type: "text-delta" }
  })(),
})))

vi.mock("ai", () => ({
  generateText,
  jsonSchema,
  isStepCount: vi.fn(count => ({ count })),
  Output: { object: vi.fn(({ schema }) => ({ schema })) },
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

vi.mock("@vite-hub/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/workspace")>()
  return {
    ...actual,
    createWorkspaceTools,
    resolveRegisteredWorkspaceDefinition,
    resolveWorkspaceAutoCommit,
    useWorkspace,
  }
})

vi.mock("@vite-hub/workspace/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/workspace/runtime")>()
  return {
    ...actual,
    createWorkspaceSourceResolutionFacade,
    getWorkspaceSourceRequestDescriptor,
    isWorkspaceSourceRequestOnly,
    resolveRegisteredWorkspaceDefinition,
    workspaceSourceRequestDescriptorPath,
    useWorkspace,
  }
})

const { defineAgent: defineNamedWorkspaceTestAgent } = await import("../src/index.ts")

function withExplicitWorkspaceName<
  TAgent extends { name?: string, __vitehubWorkspaceAgentOptions: Record<string, unknown> },
>(agent: TAgent, options: { workspace?: string }): TAgent {
  if (!options.workspace || agent.name) return agent
  return defineNamedWorkspaceTestAgent({
    ...agent.__vitehubWorkspaceAgentOptions,
    name: options.workspace,
  } as never) as unknown as TAgent
}

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
    fs: { exists, list, readFile, stat },
    tools: Object.assign(vi.fn(() => ({})), {
      inspect: inspectTools,
      none: vi.fn(() => ({})),
      readonly: inspectTools,
    }),
  } as unknown as ReadonlyWorkspaceFacade
}

describe("defineAgent workspace option", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  beforeEach(() => {
    agentSettings.length = 0
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
    jsonSchema.mockClear()
    exists.mockReset()
    exists.mockResolvedValue(false)
    stat.mockReset()
    diff.mockReset()
    diff.mockResolvedValue({ entries: [], to: "next" })
    list.mockReset()
    list.mockResolvedValue([])
    readFile.mockReset()
    rebase.mockReset()
    writeFile.mockReset()
    snapshot.mockReset()
    resolveRegisteredWorkspaceDefinition.mockReset()
    resolveRegisteredWorkspaceDefinition.mockResolvedValue(undefined)
    resolveWorkspaceAutoCommit.mockReset()
    resolveWorkspaceAutoCommit.mockReturnValue(undefined)
    tools.mockClear()
    inspectTools.mockReset()
    inspectTools.mockReturnValue({})
    writeTools.mockReset()
    writeTools.mockReturnValue({})
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

  it("infers Workspace Agents from static and normalized channel capabilities", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const workspaceCapability = defineCapability({
      id: "review-workspace",
      workspace: { sources: {} },
    })
    const writeWorkspaceCapability = defineCapability({
      id: "write-review-workspace",
      requires: [{ primitive: "workspace", workspace: { mode: "write", required: true } }],
      workspace: { sources: {} },
    })
    const channelFactory = vi.fn(() => ({
      capabilities: [workspaceCapability],
      kind: "review",
    }))

    const staticAgent = defineAgent({
      capabilities: [workspaceCapability],
      driver: { run: () => "ok" },
    })
    const channelAgent = defineAgent({
      channels: { review: channelFactory },
      driver: { run: () => "ok" },
    })
    const writeAgent = defineAgent({
      capabilities: [workspaceCapability, writeWorkspaceCapability],
      driver: { run: () => "ok" },
    })
    const baseAgent = defineAgent({
      driver: { run: () => "ok" },
    })

    expect(staticAgent).toMatchObject({
      __vitehubWorkspaceAgent: true,
      __vitehubWorkspaceAgentOptions: { workspace: { mode: "read" } },
    })
    expect(channelAgent).toMatchObject({
      __vitehubWorkspaceAgent: true,
      __vitehubWorkspaceAgentOptions: { workspace: { mode: "read" } },
      channels: {
        review: {
          capabilities: [workspaceCapability],
          kind: "review",
        },
      },
    })
    expect(writeAgent).toMatchObject({
      __vitehubWorkspaceAgent: true,
      __vitehubWorkspaceAgentOptions: { workspace: { mode: "write" } },
    })
    expect(channelFactory).toHaveBeenCalledOnce()
    expect(baseAgent).not.toHaveProperty("__vitehubWorkspaceAgent")
  })

  it("fails when a capability-required workspace path is missing", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [skills({ path: "agent-skills/support" })],
      driver: { model: {} as never },
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
      driver: { model: {} as never },
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
      driver: { model: {} as never },
      workspace: {},
    })

    await expect(agent.run!(context())).resolves.toBe("ok")
  })

  it("applies Driver capacity to synthetic Workspace runs", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const releases: Array<() => void> = []
    let starts = 0
    agentGenerate.mockImplementation(async () => {
      starts++
      await new Promise<void>(resolve => releases.push(resolve))
      return { finishReason: "stop", text: "ok" }
    })
    const agent = defineAgent({
      driver: { capacity: { concurrency: 1, queue: { maxPending: 1 } }, model: {} as never },
      workspace: {},
    })

    const first = agent.run!(context())
    await vi.waitFor(() => expect(starts).toBe(1))
    const second = agent.run!(context())
    await Promise.resolve()
    expect(starts).toBe(1)

    releases.shift()!()
    await expect(first).resolves.toBe("ok")
    await vi.waitFor(() => expect(starts).toBe(2))
    releases.shift()!()
    await expect(second).resolves.toBe("ok")
  })

  it("does not add generated model instructions for mounted skills", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")
    useWorkspace.mockReturnValueOnce({
      diff,
      fs: { exists, list, readFile, writeFile },
      snapshot,
      startSession: vi.fn(),
      tools: Object.assign(tools, {
        inspect: inspectTools,
        none: vi.fn(() => ({})),
        readonly: inspectTools,
      }),
    } as unknown as WritableWorkspaceFacade)
    exists.mockResolvedValue(true)

    const agent = defineAgent({
      capabilities: [skills({ path: "skills/agent-browser", shellExecution: "write" })],
      driver: { model: {} as never },
      workspace: { mode: "write" },
    })

    await agent.run!(context())

    expect(readFile).not.toHaveBeenCalledWith("skills/agent-browser/SKILL.md")
    expect(agentSettings.at(-1)?.instructions).toBe("")
  })

  it("records opt-in skill shell execution mode", async () => {
    const { skills } = await import("../src/capabilities.ts")

    expect(skills().metadata).not.toHaveProperty("shellExecution")
    expect(skills({ shellExecution: "read" }).metadata).toMatchObject({ shellExecution: "read" })
    expect(skills({ shellExecution: "write" }).metadata).toMatchObject({ shellExecution: "write" })
    expect(() => skills({ shellExecution: "execute" as never })).toThrow("skills({ shellExecution })")
  })

  it("lets skills() contribute a mounted workspace source", async () => {
    const { skills } = await import("../src/capabilities.ts")
    const { workspaceDefinitionFromOptions } = await import("../src/workspace-agent.ts")

    const definition = workspaceDefinitionFromOptions({
      capabilities: [
        skills({
          path: "skills/agent-browser",
          source: {
            include: ["SKILL.md", "references/**"],
            materialize: "build",
            repo: "vercel/vercel-plugin",
            root: "skills/agent-browser",
          } as never,
        }),
      ],
      driver: { model: {} as never, },
      workspace: {},
    })

    expect(definition.sources?.["skill.agent-browser"]).toEqual({
      mount: "skills/agent-browser",
      source: {
        include: ["SKILL.md", "references/**"],
        materialize: "build",
        repo: "vercel/vercel-plugin",
        root: "skills/agent-browser",
      },
    })
  })

  it("merges workspace commit shorthand into rules that omit commit", async () => {
    const { workspaceDefinitionFromOptions, workspaceDefinitionWithAutoCommitRules } = await import("../src/workspace-agent.ts")

    const definition = workspaceDefinitionWithAutoCommitRules(workspaceDefinitionFromOptions({
      driver: { model: {} as never },
      workspace: {
        rules: {
          "**": { write: true },
          "archive/**": { commit: false, write: true },
          "notes/**": { commit: "chore: update notes" },
          "uploads/**": { write: true },
        },
      },
    }) as never, "chore: update workspace")

    expect(definition.rules).toEqual({
      "**": { commit: "chore: update workspace", write: true },
      "archive/**": { commit: false, write: true },
      "notes/**": { commit: "chore: update notes" },
      "uploads/**": { commit: "chore: update workspace", write: true },
    })
  })

  it("rebases file skill sources under the configured skill path", async () => {
    const { skills } = await import("../src/capabilities.ts")
    const { workspaceDefinitionFromOptions } = await import("../src/workspace-agent.ts")

    const definition = workspaceDefinitionFromOptions({
      capabilities: [
        skills({
          path: "skills/agent-browser",
          source: { path: "skills/agent-browser/SKILL.md" },
        }),
      ],
      driver: { model: {} as never, },
      workspace: {},
    })

    expect(definition.sources?.["skill.agent-browser"]).toEqual({
      mount: "skills/agent-browser",
      source: {
        path: "skills/agent-browser/SKILL.md",
        workspacePath: "SKILL.md",
      },
    })
  })

  it("mounts skill sources at the configured skill path", async () => {
    const { skills } = await import("../src/capabilities.ts")
    const { workspaceDefinitionFromOptions } = await import("../src/workspace-agent.ts")

    const definition = workspaceDefinitionFromOptions({
      capabilities: [
        skills({
          path: "skills/agent-browser",
          source: {
            mount: "vercel-plugin",
            repo: "vercel/vercel-plugin",
            root: "skills/agent-browser",
          } as never,
        }),
      ],
      driver: { model: {} as never, },
      workspace: {},
    })

    expect(definition.sources?.["skill.agent-browser"]).toEqual({
      mount: "skills/agent-browser",
      source: {
        mount: "vercel-plugin",
        repo: "vercel/vercel-plugin",
        root: "skills/agent-browser",
      },
    })
  })

  it("bubbles subagent skill sources into the parent workspace definition", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills, subagents } = await import("../src/capabilities.ts")
    const { workspaceDefinitionFromOptions } = await import("../src/workspace-agent.ts")

    const browserAgent = defineAgent({
      capabilities: [
        skills({
          path: "skills/agent-browser",
          source: {
            materialize: "build",
            repo: "vercel/vercel-plugin",
            root: "skills/agent-browser",
          } as never,
        }),
      ],
      driver: { model: {} as never },
      workspace: { name: "review", mode: "write" },
    })
    const reviewerAgent = defineAgent({
      capabilities: [
        subagents({
          agents: {
            browser: {
              agent: browserAgent,
              description: "Collect browser evidence.",
            },
          },
        }),
      ],
      driver: { model: {} as never },
      workspace: { mode: "write" },
    })
    const options = (reviewerAgent as unknown as { __vitehubWorkspaceAgentOptions: Parameters<typeof workspaceDefinitionFromOptions>[0] }).__vitehubWorkspaceAgentOptions

    expect(workspaceDefinitionFromOptions(options).sources?.["skill.agent-browser"]).toEqual({
      mount: "skills/agent-browser",
      source: {
        materialize: "build",
        repo: "vercel/vercel-plugin",
        root: "skills/agent-browser",
      },
    })
  })

  it("leaves invocation-resolved subagent Capabilities out of static source discovery", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { subagents } = await import("../src/capabilities.ts")

    const child = defineAgent({
      capabilities: () => [],
      driver: { run: () => "ok" },
      workspace: {},
    })
    const capability = subagents({
      agents: {
        child: {
          agent: child,
          description: "Handle one delegated task.",
        },
      },
    })

    expect(capability.workspaceSources).toBeUndefined()
  })

  it("adds capability sources to shared named workspace references for one invocation", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")
    const { registerWorkspace } = await import("@vite-hub/workspace/runtime")
    const workspaceName = `review-${Math.random().toString(36).slice(2)}`
    const registeredDefinition: {
      name: string
      sources: Record<string, WorkspaceSourceInput>
      store: { provider: "memory" }
    } = {
      name: workspaceName,
      sources: {
        instructions: { path: "AGENTS.md" } as never,
      },
      store: { provider: "memory" as const },
    }
    registerWorkspace(workspaceName, {
      sources: registeredDefinition.sources,
      store: registeredDefinition.store,
    })
    resolveRegisteredWorkspaceDefinition.mockResolvedValueOnce(registeredDefinition)
    exists.mockResolvedValue(true)

    const agent = defineAgent({
      capabilities: [
        skills({
          path: "skills/agent-browser",
          source: {
            materialize: "build",
            repo: "vercel/vercel-plugin",
            root: "skills/agent-browser",
          } as never,
        }),
      ],
      driver: { model: {} as never },
      workspace: { name: workspaceName, mode: "write" },
    })

    await agent.run!(context())

    expect(registeredDefinition.sources?.instructions).toEqual({ path: "AGENTS.md" })
    expect(registeredDefinition.sources?.["skill.agent-browser"]).toBeUndefined()
    expect(useWorkspace).toHaveBeenCalledWith(workspaceName, {
      definition: expect.objectContaining({
        sources: {
          instructions: { path: "AGENTS.md" },
          "skill.agent-browser": {
            mount: "skills/agent-browser",
            source: {
              materialize: "build",
              repo: "vercel/vercel-plugin",
              root: "skills/agent-browser",
            },
          },
        },
        store: { provider: "memory" },
      }),
      mode: "write",
    })
  })

  it("attaches skill sources before validating the required skill path", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")
    const workspaceName = `review-${Math.random().toString(36).slice(2)}`
    const skillSource = {
      include: ["SKILL.md", "references/**", "templates/**"],
      materialize: "lazy",
      ref: "d9884256545389d67cfaba12cac9f8c60b5630e9",
      repo: "vercel/vercel-plugin",
      root: "skills/agent-browser",
    }
    let validated = false
    exists.mockImplementationOnce(async (path) => {
      expect(path).toBe("skills/agent-browser/SKILL.md")
      expect(useWorkspace).toHaveBeenCalledWith(workspaceName, {
        definition: expect.objectContaining({
          sources: {
            "skill.agent-browser": {
              mount: "skills/agent-browser",
              source: skillSource,
            },
          },
        }),
        mode: "read",
      })
      validated = true
      return true
    })

    const agent = defineAgent({
      capabilities: [
        skills({
          path: "skills/agent-browser",
          source: skillSource as never,
        }),
      ],
      driver: { model: {} as never },
      workspace: { name: workspaceName },
    })

    await expect(agent.run!(context())).resolves.toBe("ok")
    expect(validated).toBe(true)
  })

  it("rejects duplicate capability source keys on shared named workspace references", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")
    const workspaceName = `review-${Math.random().toString(36).slice(2)}`
    resolveRegisteredWorkspaceDefinition.mockResolvedValueOnce({
      name: workspaceName,
      sources: {
        instructions: { path: "AGENTS.md" } as never,
      },
      store: { provider: "memory" as const },
    })
    const agent = defineAgent({
      capabilities: [
        skills({
          path: "skills/agent-browser",
          source: {
            materialize: "build",
            repo: "vercel/vercel-plugin",
            root: "skills/agent-browser",
          } as never,
          sourceKey: "instructions",
        }),
      ],
      driver: { model: {} as never },
      workspace: { name: workspaceName, mode: "write" },
    })

    await expect(agent.run!(context())).rejects.toThrow('Workspace source "instructions" is already defined.')
  })

  it("exposes read-mode skill shell execution through Workspace Shell inspect tools", async () => {
    inspectTools.mockReturnValueOnce({
      workspace_shell: { name: "workspace_shell" },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, unknown> } }) {
      return { finishReason: "stop", text: Object.keys(this.settings.tools).sort().join(",") }
    })
    exists.mockResolvedValue(true)
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [skills({ path: "skills/agent-browser", shellExecution: "read" })],
      driver: { model: {} as never },
      workspace: {},
    })

    await expect(agent.run!(context())).resolves.toBe("workspace_shell")
    expect(inspectTools).toHaveBeenCalledTimes(1)
    expect(writeTools).not.toHaveBeenCalled()
  })

  it("exposes write-mode skill shell execution through Workspace Shell write tools", async () => {
    writeTools.mockReturnValueOnce({
      workspace_write: { name: "workspace_write" },
    })
    useWorkspace.mockReturnValueOnce({
      diff,
      fs: { exists, list, readFile, writeFile },
      snapshot,
      tools: Object.assign(tools, {
        inspect: inspectTools,
        none: vi.fn(() => ({})),
        readonly: inspectTools,
        write: writeTools,
      }),
    } as unknown as WritableWorkspaceFacade)
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, unknown> } }) {
      return { finishReason: "stop", text: Object.keys(this.settings.tools).sort().join(",") }
    })
    exists.mockResolvedValue(true)
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [skills({ path: "skills/agent-browser", shellExecution: "write" })],
      driver: { model: {} as never },
      workspace: { mode: "write" },
    })

    await expect(agent.run!(context())).resolves.toBe("workspace_write")
    expect(writeTools).toHaveBeenCalledTimes(1)
    expect(inspectTools).not.toHaveBeenCalled()
  })

  it("allows read-mode skill shell execution on read workspaces", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")
    exists.mockResolvedValue(true)

    const agent = defineAgent({
      capabilities: [skills({ path: "skills/agent-browser", shellExecution: "read" })],
      driver: { model: {} as never },
      workspace: {},
    })

    await expect(agent.run!(context())).resolves.toBe("ok")
  })

  it("requires writable workspace for write-mode skill shell execution", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [skills({ path: "agent-skills/support", shellExecution: "write" })],
      driver: { model: {} as never },
      workspace: { mode: "read" },
    })

    await expect(agent.run!(context())).rejects.toThrow("skills() requires workspace.mode: \"write\"")
  })

  it("requires writable workspace for git commands", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { git } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [git()],
      driver: { model: {} as never },
      workspace: { mode: "read" },
    })

    await expect(agent.run!(context())).rejects.toThrow("git() requires workspace.mode: \"write\"")
  })

  it("uses write mode for named workspace references", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { workspaceShell } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [workspaceShell({ mode: "write" })],
      driver: { model: {} as never },
      workspace: { name: "docs", mode: "write" },
    })

    await agent.run!(context())

    expect(useWorkspace).toHaveBeenCalledWith("docs", { mode: "write" })
  })

  it("rejects mixed named workspace references and colocated definitions", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expect(() => defineAgent({
      driver: { model: {} as never },
      workspace: {
        name: "docs",
        sources: {},
      } as never,
    })).toThrow("[vitehub] Workspace reference does not support option: sources.")
  })

  it("creates a workspace and agent definition without resolving workspace until run", async () => {
    const { useWorkspace } = await import("@vite-hub/workspace")
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      workspace: {
        sources: {},
      },
      description: "Answer from workspace context",
      driver: { model: {} as never },
    })

    expect(agent.description).toBe("Answer from workspace context")
    expect(agent.sources).toEqual({})
    expect(useWorkspace).not.toHaveBeenCalled()
  })

  it("rejects unknown colocated Workspace Definition options", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expect(() => defineAgent({
      driver: { model: {} as never },
      workspace: {
        stroe: { provider: "memory" },
      } as never,
    })).toThrow("[vitehub] defineWorkspace does not support option: stroe.")
  })

  it("accepts colocated Workspace auto-commit", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      driver: { model: {} as never },
      workspace: {
        commit: "chore: update workspace",
        store: { provider: "memory" },
      },
    })

    expect(agent.workspace).toEqual({
      mode: "read",
      store: { provider: "memory" },
    })
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        mode: "write",
        rules: {
          "inbox/**": { commit: "chore: archive audio", write: true },
        },
      },
      driver: { run: async ({ workspace }) => {
          await (workspace as WritableWorkspaceFacade).fs.writeFile("inbox/audio.md", "transcript")
          return "ok"
        } },
    }), { workspace: "docs" })

    await expect(runAgent(agent, context(), { messages: [] })).resolves.toBe("ok")

    expect(useWorkspace).toHaveBeenCalledWith("docs", {
      definition: {
        mode: "write",
        name: "docs",
        rules: { "inbox/**": { commit: "chore: archive audio", write: true } },
      },
      mode: "write",
    })
    expect(resolveWorkspaceAutoCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "docs",
        rules: { "inbox/**": { commit: "chore: archive audio", write: true } },
      }),
      expect.objectContaining({ entries: [expect.objectContaining({ path: "inbox/audio.md" })] }),
    )
    expect(snapshot).toHaveBeenCalledWith({ name: "chore: archive audio" })
  })

  it("rebases and retries racing Workspace auto-commits", async () => {
    diff.mockResolvedValueOnce({
      entries: [{ after: { type: "file" }, path: "inbox/audio.md", type: "added" }],
      to: "next",
    })
    resolveWorkspaceAutoCommit.mockReturnValueOnce({
      message: "chore: archive audio",
      paths: ["inbox/audio.md"],
    })
    snapshot
      .mockRejectedValueOnce(new ViteHubError("WORKSPACE_CONFLICT", "Remote Workspace changed."))
      .mockRejectedValueOnce(new ViteHubError("WORKSPACE_CONFLICT", "Remote Workspace changed again."))
    const { defineAgent, runAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: { commit: "chore: archive audio", mode: "write" },
      driver: { run: () => "ok" },
    }), { workspace: "docs" })

    await expect(runAgent(agent, context(), { messages: [] })).resolves.toBe("ok")

    expect(rebase).toHaveBeenCalledTimes(2)
    expect(snapshot).toHaveBeenCalledTimes(3)
    expect(snapshot).toHaveBeenNthCalledWith(3, { name: "chore: archive audio" })
  })

  it("bounds conflicting Workspace auto-commit retries", async () => {
    diff.mockResolvedValueOnce({
      entries: [{ after: { type: "file" }, path: "inbox/audio.md", type: "added" }],
      to: "next",
    })
    resolveWorkspaceAutoCommit.mockReturnValueOnce({
      message: "chore: archive audio",
      paths: ["inbox/audio.md"],
    })
    snapshot.mockRejectedValue(new ViteHubError("WORKSPACE_CONFLICT", "Remote Workspace changed."))
    const { defineAgent, runAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: { commit: "chore: archive audio", mode: "write" },
      driver: { run: () => "ok" },
    }), { workspace: "docs" })

    await expect(runAgent(agent, context(), { messages: [] }))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })

    expect(rebase).toHaveBeenCalledTimes(2)
    expect(snapshot).toHaveBeenCalledTimes(3)
  })

  it("turns workspace commit into a default auto-commit rule", async () => {
    diff.mockResolvedValueOnce({
      entries: [{ after: { type: "file" }, path: "notes/day.md", type: "added" }],
      to: "next",
    })
    resolveWorkspaceAutoCommit.mockReturnValueOnce({
      message: "chore: archive notes",
      paths: ["notes/day.md"],
    })
    const { defineAgent, runAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        commit: "chore: archive notes",
        mode: "write",
      },
      driver: { run: async ({ workspace }) => {
          await (workspace as WritableWorkspaceFacade).fs.writeFile("notes/day.md", "entry")
          return "ok"
        } },
    }), { workspace: "docs" })

    await expect(runAgent(agent, context(), { messages: [] })).resolves.toBe("ok")

    expect(resolveWorkspaceAutoCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "docs",
        rules: { "**": { commit: "chore: archive notes", write: true } },
      }),
      expect.objectContaining({ entries: [expect.objectContaining({ path: "notes/day.md" })] }),
    )
    expect(snapshot).toHaveBeenCalledWith({ name: "chore: archive notes" })
  })

  it("applies workspace commit to matching rules without their own commit", async () => {
    diff.mockResolvedValueOnce({
      entries: [{ after: { type: "file" }, path: "notes/day.md", type: "added" }],
      to: "next",
    })
    resolveWorkspaceAutoCommit.mockReturnValueOnce({
      message: "chore: archive notes",
      paths: ["notes/day.md"],
    })
    const { defineAgent, runAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        commit: "chore: archive notes",
        mode: "write",
        rules: {
          "notes/**": { write: true },
        },
      },
      driver: { run: async ({ workspace }) => {
          await (workspace as WritableWorkspaceFacade).fs.writeFile("notes/day.md", "entry")
          return "ok"
        } },
    }), { workspace: "docs" })

    await expect(runAgent(agent, context(), { messages: [] })).resolves.toBe("ok")

    expect(resolveWorkspaceAutoCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "docs",
        rules: {
          "**": { commit: "chore: archive notes", write: true },
          "notes/**": { commit: "chore: archive notes", write: true },
        },
      }),
      expect.objectContaining({ entries: [expect.objectContaining({ path: "notes/day.md" })] }),
    )
    expect(snapshot).toHaveBeenCalledWith({ name: "chore: archive notes" })
  })

  it("does not conflict workspace commit fallback with capability workspace rules", async () => {
    diff.mockResolvedValueOnce({
      entries: [{ after: { type: "file" }, path: "review/summary.md", type: "added" }],
      to: "next",
    })
    resolveWorkspaceAutoCommit.mockReturnValueOnce({
      message: "chore: archive review",
      paths: ["review/summary.md"],
    })
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      capabilities: [
        defineCapability({
          id: "review-rules",
          workspace: () => ({
            rules: {
              "review/**": { write: true },
            },
          }),
        }),
      ],
      workspace: {
        commit: "chore: archive review",
        mode: "write",
      },
      driver: { run: async ({ workspace }) => {
          await (workspace as WritableWorkspaceFacade).fs.writeFile("review/summary.md", "ready")
          return "ok"
        } },
    }), { workspace: "docs" })

    await expect(runAgent(agent, context(), { messages: [] })).resolves.toBe("ok")

    expect(resolveWorkspaceAutoCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "docs",
        rules: {
          "**": { commit: "chore: archive review", write: true },
          "review/**": { commit: "chore: archive review", write: true },
        },
      }),
      expect.objectContaining({ entries: [expect.objectContaining({ path: "review/summary.md" })] }),
    )
    expect(snapshot).toHaveBeenCalledWith({ name: "chore: archive review" })
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        mode: "write",
        rules: {
          "inbox/**": { commit: "chore: archive stream", write: true },
        },
      },
      driver: { run: async ({ workspace }) => {
          await (workspace as WritableWorkspaceFacade).fs.writeFile("inbox/stream.md", "transcript")
          return (async function* () {
            yield { text: "ok", type: "text-delta" }
          })()
        } },
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        mode: "write",
        rules: {
          "inbox/**": { commit: "chore: archive response", write: true },
        },
      },
      driver: { run: async ({ workspace }) => {
          await (workspace as WritableWorkspaceFacade).fs.writeFile("inbox/response.md", "transcript")
          return new Response("ok")
        } },
    }), { workspace: "docs" })

    const response = await runAgent(agent, context(), { messages: [] }) as Response
    expect(snapshot).not.toHaveBeenCalled()
    await expect(response.text()).resolves.toBe("ok")

    expect(snapshot).toHaveBeenCalledWith({ name: "chore: archive response" })
  })

  it("uses string instructions", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        instructions: "Use workspace sources.",
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("Use workspace sources.")
  })

  it("uses colocated instructions.md as default model instructions", async () => {
    const sourceRootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-"))
    tempRoots.push(sourceRootDir)
    await writeLocalFile(join(sourceRootDir, "instructions.md"), "Use colocated workspace instructions.\n")
    readFile.mockResolvedValueOnce("Use colocated workspace instructions.\n")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: { sourceRootDir },
      driver: { model: {} as never },
    }), { workspace: "docs" })

    expect((agent as { sources?: unknown }).sources).toMatchObject({
      __vitehubAgentInstructions: {
        mount: "",
        path: "instructions.md",
        workspacePath: "AGENTS.md",
      },
    })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Use colocated workspace instructions.")
  })

  it("composes colocated, Channel, and output instructions", async () => {
    const sourceRootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-"))
    tempRoots.push(sourceRootDir)
    await writeLocalFile(join(sourceRootDir, "instructions.md"), "Use colocated workspace instructions.\n")
    readFile.mockResolvedValueOnce("Use colocated workspace instructions.\n")
    agentGenerate.mockResolvedValueOnce({ finishReason: "stop", text: "{\"title\":\"ok\"}" })
    const { telegram } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { createMessage } = await import("../src/messages.ts")
    const schema = {
      "~standard": {
        jsonSchema: {
          input: () => ({
            properties: { title: { type: "string" } },
            required: ["title"],
            type: "object",
          }),
          output: () => ({ type: "object" }),
        },
        validate: (value: unknown) => ({ value: value as { title: string } }),
        vendor: "vitehub-test",
        version: 1 as const,
      },
    }
    const agent = withExplicitWorkspaceName(defineAgent({
      channels: { support: telegram() },
      workspace: { sourceRootDir },
      driver: {
        model: {} as never,
        output: { schema },
      },
    }), { workspace: "docs" })

    await agent.run!(Object.assign(context() as object, {
      input: {
        messages: [createMessage({ role: "user", text: "Show dinner." })],
      },
      run: {
        channelId: "support",
        origin: "support",
        runId: "support:1",
        threadId: "support:1",
      },
    }) as never)

    const instructions = agentSettings.at(-1)?.instructions as string
    const ordered = [
      "Use colocated workspace instructions.",
      "Write the final response for Telegram.",
      "Return only one valid JSON value for the configured Agent output.",
    ]
    let previousIndex = -1
    for (const instruction of ordered) {
      const index = instructions.indexOf(instruction)
      expect(index).toBeGreaterThan(previousIndex)
      expect(instructions.indexOf(instruction, index + instruction.length)).toBe(-1)
      previousIndex = index
    }
  })

  it("applies discovered source roots to workspace agents", async () => {
    const sourceRootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-"))
    tempRoots.push(sourceRootDir)
    await writeLocalFile(join(sourceRootDir, "instructions.md"), "Use discovered workspace instructions.\n")
    const { defineAgent } = await import("../src/index.ts")
    const { workspaceAgentWithSourceRoot } = await import("../src/workspace-agent.ts")

    const agent = workspaceAgentWithSourceRoot(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), sourceRootDir, "Use generated instructions.\n")

    expect((agent as { sourceRootDir?: string }).sourceRootDir).toBe(sourceRootDir)
    expect((agent as { sources?: unknown }).sources).toMatchObject({
      __vitehubAgentInstructions: {
        content: "Use generated instructions.\n",
        materialize: "build",
        mount: "",
        workspacePath: "AGENTS.md",
      },
    })
    expect((agent as { __vitehubWorkspaceAgentOptions?: { workspace?: { sourceRootDir?: string } } }).__vitehubWorkspaceAgentOptions?.workspace?.sourceRootDir)
      .toBe(sourceRootDir)
  })

  it("does not replay capability workspace sources when applying discovered roots", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")
    const { workspaceAgentWithSourceRoot } = await import("../src/workspace-agent.ts")

    const agent = defineAgent({
      workspace: {},
      capabilities: [skills({ path: "skills/review", source: { path: "/opt/skills/review" } })],
      driver: { model: {} as never },
    })

    const discoveredAgent = workspaceAgentWithSourceRoot(agent, "/workspace") as { sources?: unknown }
    expect(discoveredAgent.sources).toHaveProperty("skill.review")
  })

  it("keeps colocated default model instructions without source config prose", async () => {
    const sourceRootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-"))
    tempRoots.push(sourceRootDir)
    await writeLocalFile(join(sourceRootDir, "instructions.md"), "Use colocated workspace instructions.\n")
    readFile.mockResolvedValueOnce("Use colocated workspace instructions.\n")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sourceRootDir,
        sources: { docs: { name: "docs" } as never },
      },
      driver: { model: {} as never },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("Use colocated workspace instructions.")
  })

  it("composes colocated instruction documents from invocation context", async () => {
    const sourceRootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-"))
    tempRoots.push(sourceRootDir)
    const document = [
      "# Support",
      "@./policy.md",
      "",
      "::if{context.audience === 'technical'}",
      "Use technical detail for {{ context.customerName }}.",
      "::else",
      "Use support detail.",
      "::",
      "",
      "{{{ context.supportPolicy }}}",
      "",
      "::source{key=\"docs\"}",
      "Use docs for {{ context.customerName }}.",
      "::",
      "",
      "::capability{key=\"support-context\"}",
      "Use runtime support context for {{ context.customerName }}.",
      "::",
    ].join("\n")
    await writeLocalFile(join(sourceRootDir, "instructions.md"), document)
    await writeLocalFile(join(sourceRootDir, "policy.md"), "Imported policy.\n")
    readFile.mockResolvedValueOnce(document)
    const { defineAgent, defineCapability } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      capabilities: [
        defineCapability({
          id: "support-context",
          configure(context) {
            context.context.set("audience", "technical")
            context.context.set("customerName", "Acme")
            context.context.set("supportPolicy", "## Runtime policy\nUse trusted runtime context.")
          },
        }),
      ],
      workspace: {
        sourceRootDir,
        sources: { docs: { name: "docs" } as never },
      },
      driver: { model: {} as never },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe([
      "# Support\n\nImported policy.",
      "Use technical detail for Acme.",
      "## Runtime policy\n\nUse trusted runtime context.",
      "Use docs for Acme.",
      "Use runtime support context for Acme.",
    ].join("\n\n"))
  })

  it("reads materialized colocated instructions without host fs", async () => {
    const processWithBuiltins = globalThis.process as typeof process & {
      getBuiltinModule?: (name: string) => unknown
    }
    const getBuiltinModule = processWithBuiltins.getBuiltinModule
    processWithBuiltins.getBuiltinModule = () => undefined
    readFile.mockResolvedValueOnce("Use materialized workspace instructions.\n")

    try {
      const { defineAgent } = await import("../src/index.ts")
      const agent = withExplicitWorkspaceName(defineAgent({
        workspace: {
          sourceRootDir: "/runtime/server/agents/support",
          sources: {
            __vitehubAgentInstructions: {
              materialize: "build",
              mount: "",
              path: "instructions.md",
              workspacePath: "AGENTS.md",
            },
          },
        },
        driver: { model: {} as never },
      }), { workspace: "docs" })

      await agent.run!(context())

      expect(readFile).toHaveBeenCalledWith("AGENTS.md")
      expect(agentSettings.at(-1)?.instructions).toBe("Use materialized workspace instructions.")
    }
    finally {
      processWithBuiltins.getBuiltinModule = getBuiltinModule
    }
  })

  it("keeps explicit model instructions ahead of colocated instructions.md", async () => {
    const sourceRootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-"))
    tempRoots.push(sourceRootDir)
    await writeLocalFile(join(sourceRootDir, "instructions.md"), "Use colocated workspace instructions.\n")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: { sourceRootDir },
      driver: {
        instructions: "Use explicit instructions.",
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).not.toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Use explicit instructions.")
  })

  it("keeps explicit model driver instructions ahead of colocated instructions.md", async () => {
    const sourceRootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-"))
    tempRoots.push(sourceRootDir)
    await writeLocalFile(join(sourceRootDir, "instructions.md"), "Use colocated workspace instructions.\n")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: { sourceRootDir },
      driver: {
        instructions: "Use explicit driver instructions.",
        model: {} as never,
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).not.toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Use explicit driver instructions.")
  })

  it("does not load ordinary workspace AGENTS.md as implicit instructions", async () => {
    readFile.mockResolvedValueOnce("Ordinary workspace instructions.\n")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          guide: { path: "AGENTS.md" },
        },
      },
      driver: { model: {} as never },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).not.toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("")
  })

  it("resolves explicit workspace instruction bindings through workspace files", async () => {
    readFile.mockImplementation(async (path: string) => {
      if (path === "policy.md") return "Workspace policy."
      if (path === "unused.md") return "Do not load this."
      throw new Error(`Unexpected read: ${path}`)
    })
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        bindings: {
          policy: { path: "policy.md" },
          tone: "brief",
        },
        sources: {
          unused: { path: "unused.md" },
        },
      },
      driver: {
        instructions: [
          "Use {{ workspace.tone }} tone.",
          "Inline {{ workspace.policy }}",
          "@workspace.policy",
        ],
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("policy.md")
    expect(readFile).not.toHaveBeenCalledWith("unused.md")
    expect(agentSettings.at(-1)?.instructions).toBe([
      "Use brief tone.",
      "Inline Workspace policy.",
      "Workspace policy.",
    ].join("\n\n"))
  })

  it("rebinds synthetic workspace runs with an explicit workspace name", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(useWorkspace).toHaveBeenCalledWith("docs", {
      definition: { mode: "read", name: "docs" },
      mode: "read",
    })
  })

  it("marks synthetic workspace runs with the shared runtime symbol", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      workspace: {},
      driver: { model: {} as never },
    })

    expect(agent.run && Symbol.for("vitehub.syntheticWorkspaceRun") in agent.run).toBe(true)
  })

  it("joins array instructions", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        instructions: [" First ", "", "Second"],
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("First\n\nSecond")
  })

  it("joins mixed static and callback instructions", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        instructions: [
          "Use workspace sources.",
          async ({ fs }) => await fs.readFile("AGENTS.md"),
        ],
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Use workspace sources.\n\nWorkspace instructions")
  })

  it("uses callback instructions with workspace fs", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        instructions: async ({ fs }) => await fs.readFile("AGENTS.md"),
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Workspace instructions")
  })

  it("uses the registered workspace definition for named reference instructions", async () => {
    readFile.mockResolvedValueOnce("Summary instructions")
    const { defineAgent } = await import("../src/index.ts")
    const { registerWorkspace } = await import("@vite-hub/workspace/runtime")
    const workspaceName = `shared-reference-${Math.random().toString(36).slice(2)}`
    const workspaceDefinition = {
      sources: {
        summaryInstructions: { name: "summary" } as never,
      },
      store: { provider: "memory" as const },
    }
    registerWorkspace(workspaceName, workspaceDefinition)
    resolveRegisteredWorkspaceDefinition.mockResolvedValueOnce(workspaceDefinition)

    const agent = defineAgent({
      workspace: { name: workspaceName, mode: "write" },
      driver: {
        instructions: async ({ fs }) => await fs.readFile(".agents/summary/AGENTS.md"),
        model: {} as never
      },
    })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith(".agents/summary/AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Summary instructions")
  })

  it("does not create placeholder definitions for unregistered named references", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const workspaceName = `missing-reference-${Math.random().toString(36).slice(2)}`

    const agent = defineAgent({
      workspace: { name: workspaceName, mode: "write" },
      driver: { model: {} as never },
    })

    await agent.run!(context())

    expect(useWorkspace).toHaveBeenCalledWith(workspaceName, { mode: "write" })
  })

  it("applies model Agent Driver instructions and execution settings", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const model = { id: "driver-model" }

    const agent = withExplicitWorkspaceName(defineAgent({
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
          docs: { name: "docs" } as never,
        },
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)).toMatchObject({
      instructions: "Answer from the driver.",
      model: { modelId: "driver-model" },
      stopWhen: { count: 4 },
      temperature: 0.3,
    })
  })

  it("synthesizes an answer when tool loop stops without text after tool results", async () => {
    const { telegram } = await import("../src/channels.ts")
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

    const agent = withExplicitWorkspaceName(defineAgent({
      channels: { support: telegram() },
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    await expect(agent.run!(Object.assign(context() as object, {
      run: {
        channelId: "support",
        origin: "support",
        runId: "support:1",
        threadId: "support:1",
      },
    }) as never)).resolves.toBe("fallback answer")
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      instructions: expect.stringContaining("Write the final response for Telegram."),
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
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

  it("synthesizes streamed answers when tool loops finish with tool calls after pre-tool text", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield { id: "msg-1", text: "I will inspect the workspace first.", type: "text-delta" }
        yield {
          output: { stdout: "summary.md:1: final summary from subagent" },
          toolCallId: "call-1",
          type: "tool-output-available",
        }
        yield { finishReason: "tool-calls", type: "finish" }
      })(),
    })

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("summary.md:1"),
    }))
  })

  it("synthesizes streamed answers when tool output follows pre-tool text without final text", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield { id: "msg-1", text: "I will inspect the workspace first.", type: "text-delta" }
        yield {
          output: { stdout: "screenshots/login-version-badge-desktop.png" },
          toolCallId: "call-1",
          type: "tool-output-available",
        }
        yield { finishReason: "stop", type: "finish" }
      })(),
    })

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("screenshots/login-version-badge-desktop.png"),
    }))
  })

  it("synthesizes streamed answers from finish-step tool results", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield { id: "msg-1", text: "I will inspect the workspace first.", type: "text-delta" }
        yield {
          toolResults: [
            {
              output: { text: "Browser evidence: screenshots/login-version-badge-desktop.png" },
              toolCallId: "call-1",
              toolName: "run_browser",
            },
          ],
          type: "finish-step",
        }
        yield { finishReason: "tool-calls", type: "finish" }
      })(),
    })

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("screenshots/login-version-badge-desktop.png"),
    }))
  })

  it("synthesizes streamed answers from step finish callback tool results", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockImplementationOnce(async (input: unknown) => {
      const callInput = input as { onStepEnd?: (event: unknown) => Promise<void> }
      await callInput.onStepEnd?.({
        toolResults: [
          {
            output: { text: "Browser evidence from callback: screenshots/login-version-badge-desktop.png" },
            toolCallId: "call-1",
            toolName: "run_browser",
          },
        ],
      })

      return {
        fullStream: (async function* () {
          yield { id: "msg-1", text: "I will inspect the workspace first.", type: "text-delta" }
          yield { finishReason: "tool-calls", type: "finish" }
        })(),
      }
    })

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Browser evidence from callback"),
    }))
  })

  it("keeps final stream text when callback evidence is only supporting evidence", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockImplementationOnce(async (input: unknown) => {
      const callInput = input as { onStepEnd?: (event: unknown) => Promise<void> }
      await callInput.onStepEnd?.({
        toolResults: [
          {
            output: { text: "Browser evidence from callback: screenshots/login-version-badge-desktop.png" },
            toolCallId: "call-1",
            toolName: "run_browser",
          },
        ],
      })

      return {
        fullStream: (async function* () {
          yield { id: "msg-1", text: "Final review summary.", type: "text-delta" }
          yield { finishReason: "stop", type: "finish" }
        })(),
      }
    })

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ id: "msg-1", text: "Final review summary.", type: "text-delta" })
    expect(events).not.toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
    expect(generateText).not.toHaveBeenCalled()
  })

  it("synthesizes streamed answers from captured tool execution results", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const runBrowser = vi.fn(async () => ({ text: "Browser evidence from execute: screenshots/login-version-badge-desktop.png" }))
    agentStream.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      await this.settings.tools.run_browser.execute({ message: "capture one desktop screenshot" })

      return {
        fullStream: (async function* () {
          yield { id: "msg-1", text: "I will capture browser evidence.", type: "text-delta" }
          yield { finishReason: "tool-calls", type: "finish" }
        })(),
      }
    })

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
      capabilities: [{
        id: "subagents",
        tools: {
          run_browser: { execute: runBrowser },
        } as never,
      }],
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(runBrowser).toHaveBeenCalledWith({ message: "capture one desktop screenshot" })
    expect(events).toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Browser evidence from execute"),
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
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

  it("synthesizes streamed answers from stream-only AI SDK results", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockResolvedValueOnce({
      stream: (async function* () {
        yield {
          output: { stdout: "screenshots/login-version-badge-desktop.png" },
          toolCallId: "call-1",
          type: "tool-output-available",
        }
        yield { finishReason: "tool-calls", type: "finish" }
      })(),
    } as never)

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
    expect(events).toContainEqual({ reason: "workspace-fallback", type: "finish" })
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("screenshots/login-version-badge-desktop.png"),
    }))
  })

  it("synthesizes streamed answers from async iterable AI SDK results", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    agentStream.mockResolvedValueOnce((async function* () {
      yield {
        output: { stdout: "screenshots/login-version-badge-desktop.png" },
        toolCallId: "call-1",
        type: "tool-output-available",
      }
      yield { finishReason: "tool-calls", type: "finish" }
    })() as never)

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    const stream = await streamAgent(agent, context(), { messages: [] })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ id: "workspace-fallback", text: "fallback answer", type: "text-delta" })
    expect(events).toContainEqual({ finishReason: "workspace-fallback", type: "finish" })
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("screenshots/login-version-badge-desktop.png"),
    }))
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
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
    const onStepEnd = vi.fn()
    const telemetry = { integrations: [], isEnabled: true }

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        execution: {
          callSettings: {
            maxOutputTokens: 100,
            onStepEnd,
            stopWhen: stopWhen as never,
            temperature: 0.2,
            telemetry: telemetry as never,
            toolChoice: "auto",
          },
        },
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)).toMatchObject({
      maxOutputTokens: 100,
      onStepEnd,
      stopWhen,
      temperature: 0.2,
      telemetry: {
        integrations: expect.any(Array),
        isEnabled: true,
      },
      toolChoice: "auto",
    })
  })

  it("passes direct channel context to dynamic AI SDK model callbacks", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const resolveModel = vi.fn((metadata: { channel?: { meta?: { customer?: string } } }) => ({
      id: `model-${metadata.channel?.meta?.customer}`,
    }))
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: resolveModel as never },
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      input: {
        context: { channel: { meta: { customer: "acme" } } },
        messages: [],
      },
    } as never)

    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({
      channel: { meta: { customer: "acme" } },
    }))
    expect(agentSettings.at(-1)?.model).toMatchObject({ modelId: "model-acme" })
  })

  it("passes provider-defined capability tools to AI SDK agents", async () => {
    const { webSearch } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      capabilities: [webSearch({ mode: "model" })],
      driver: { model: {} as never },
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
    const agent = withExplicitWorkspaceName(defineAgent({
      driver: {
        run
      },
      workspace: {},
    }), { workspace: "docs" })

    const result = await streamAgent(agent as never, context(), { messages: [] }) as AsyncIterable<unknown>
    const events = []
    for await (const event of result) events.push(event)

    expect(events).toEqual([{ text: "ok", type: "text-delta" }])
    expect(run).toHaveBeenCalled()
  })

  it("wraps workspace agent models with runtime instrumentation", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const baseModel = { id: "base" }
    const wrappedModel = { id: "wrapped" }
    const instrumentModel = vi.fn(() => wrappedModel as never)

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        execution: {
          callSettings: {
            onStepEnd: vi.fn(),
          },
          instrumentation: {
            model: instrumentModel,
          },
        },
        model: baseModel as never
      },
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
      model: expect.objectContaining({ modelId: "base" }),
      run: expect.objectContaining({ runId: "run_123" }),
    }))
    expect(agentSettings.at(-1)).toMatchObject({
      model: wrappedModel,
      onStepEnd: expect.any(Function),
    })
    expect(agentSettings.at(-1)).not.toHaveProperty("modelExecution")
  })

  it("lets capabilities instrument workspace agent model execution", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const baseModel = { id: "base" }
    const driverModel = { id: "driver" }
    const capabilityModel = { id: "capability" }
    const driverInstrumentModel = vi.fn(() => driverModel as never)
    const capabilityInstrumentModel = vi.fn(() => capabilityModel as never)
    const driverInstrumentCallSettings = vi.fn(({ callSettings }) => ({
      temperature: callSettings.temperature,
      topK: 1,
    }))
    const capabilityInstrumentCallSettings = vi.fn(({ callSettings }) => ({
      metadata: { topK: callSettings.topK },
    }))

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      capabilities: [
        defineCapability({
          id: "model-instrumentation",
          configure(context) {
            context.modelExecution.instrument({
              callSettings: capabilityInstrumentCallSettings,
              model: capabilityInstrumentModel,
            })
          },
        }),
        defineCapability({
          id: "finish-extension-trap",
          configure(context) {
            context.finish.provide(() => {
              throw new Error("finish extension should not run")
            })
          },
        }),
      ],
      driver: {
        execution: {
          callSettings: {
            temperature: 0.2,
          },
          instrumentation: {
            callSettings: driverInstrumentCallSettings,
            model: driverInstrumentModel,
          },
        },
        model: baseModel as never
      },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(driverInstrumentModel).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ modelId: "base" }),
    }))
    expect(capabilityInstrumentModel).toHaveBeenCalledWith(expect.objectContaining({ model: driverModel }))
    expect(driverInstrumentCallSettings).toHaveBeenCalledWith(expect.objectContaining({
      callSettings: expect.objectContaining({ temperature: 0.2 }),
      model: capabilityModel,
    }))
    expect(capabilityInstrumentCallSettings).toHaveBeenCalledWith(expect.objectContaining({
      callSettings: expect.objectContaining({ temperature: 0.2, topK: 1 }),
      model: capabilityModel,
    }))
    expect(agentSettings.at(-1)).toMatchObject({
      metadata: { topK: 1 },
      model: capabilityModel,
      temperature: 0.2,
      topK: 1,
    })
  })

  it("lets workspace agents instrument AI SDK call settings per run", async () => {
    const execute = vi.fn(async () => "workspace result")
    const instrumentCallSettings = vi.fn(({ callSettings }) => ({
      telemetry: { isEnabled: true, runScoped: true },
      temperature: callSettings.temperature,
    }))
    inspectTools.mockReturnValueOnce({
      shell: { execute },
    })
    const { defineAgent } = await import("../src/index.ts")
    const model = { id: "base" }

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        execution: {
          callSettings: {
            temperature: 0.2,
          },
          instrumentation: {
            callSettings: instrumentCallSettings,
          },
          stepLimit: 7,
        },
        model: model as never
      },
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      input: { context: {}, messages: [] },
      run: {
        origin: "teams",
        runId: "run_123",
        threadId: "thread_1",
      },
    } as never)

    expect(instrumentCallSettings).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ messages: [] }),
      model: expect.objectContaining({ modelId: "base" }),
      run: expect.objectContaining({ origin: "teams", runId: "run_123" }),
      callSettings: expect.objectContaining({ temperature: 0.2 }),
      tools: expect.objectContaining({ shell: expect.any(Object) }),
    }))
    expect(instrumentCallSettings.mock.calls[0]?.[0].callSettings).not.toHaveProperty("stepLimit")
    expect(agentSettings.at(-1)).toMatchObject({
      stopWhen: { count: 7 },
      temperature: 0.2,
      telemetry: { isEnabled: true, runScoped: true },
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        execution: {
          callSettings: {
            temperature: 0.2,
          },
          instrumentation: {
            callSettings: instrumentCallSettings,
          },
        },
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!(context())
    await agent.run!(context())

    expect(observedTemperatures).toEqual([0.2, 0.2])
    expect(agentSettings.slice(settingsStart)).toEqual([
      expect.objectContaining({ temperature: 0.2 }),
      expect.objectContaining({ temperature: 0.2 }),
    ])
  })

  it("passes runtime context to native AI SDK step and tool callbacks", async () => {
    const onStepEnd = vi.fn()
    const onToolExecutionStart = vi.fn()
    const onToolExecutionEnd = vi.fn()
    const onRunStepFinish = vi.fn()
    const onRunToolCallFinish = vi.fn()
    const onRunToolCallStart = vi.fn()
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        execution: {
          callSettings: {
            onStepEnd,
            onRunStepFinish: onRunStepFinish as never,
            onRunToolCallFinish: onRunToolCallFinish as never,
            onRunToolCallStart: onRunToolCallStart as never,
            onToolExecutionEnd,
            onToolExecutionStart,
          },
        },
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      input: { messages: [] },
      run: { runId: "run_123" },
    } as never)

    const settings = agentSettings.at(-1)!
    expect(settings).toMatchObject({
      onStepEnd,
      onToolExecutionEnd,
      onToolExecutionStart,
      runtimeContext: expect.objectContaining({
        input: expect.objectContaining({ messages: [] }),
        run: { runId: "run_123" },
      }),
    })
    expect(settings).not.toHaveProperty("onRunStepFinish")
    expect(settings).not.toHaveProperty("onRunToolCallFinish")
    expect(settings).not.toHaveProperty("onRunToolCallStart")
    await (settings.onStepEnd as (step: unknown) => Promise<void>)({ stepNumber: 1 })
    await (settings.onToolExecutionStart as (event: unknown) => Promise<void>)({ toolName: "shell" })
    await (settings.onToolExecutionEnd as (event: unknown) => Promise<void>)({ durationMs: 12, toolName: "shell" })

    expect(onStepEnd).toHaveBeenCalledWith({ stepNumber: 1 })
    expect(onToolExecutionStart).toHaveBeenCalledWith({ toolName: "shell" })
    expect(onToolExecutionEnd).toHaveBeenCalledWith({ durationMs: 12, toolName: "shell" })
    expect((settings.runtimeContext as { run?: unknown }).run).toEqual({ runId: "run_123" })
  })

  it("passes workspace to callback instructions", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        instructions: ({ fs, workspace }) => {
          expect(fs).toBe(workspace.fs)
          return "workspace instructions"
        },
        model: {} as never
      },
    }), { workspace: "docs" })

    await agent.run!(context({ vertex: { model: "gemini" } }))

    expect(agentSettings.at(-1)?.instructions).toBe("workspace instructions")
  })

  it("does not load AGENTS.md as implicit instructions", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).not.toHaveBeenCalled()
    expect(agentSettings.at(-1)?.instructions).toBe("")
  })

  it("throws when explicit callback instructions fail", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"))
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        instructions: ({ fs }) => fs.readFile("MISSING.md"),
        model: {} as never
      },
    }), { workspace: "docs" })

    await expect(agent.run!(context())).rejects.toThrow("missing")
  })

  it("does not attach workspace tools unless explicitly requested", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
      capabilities: [{ id: "workspace-tools", tools: toolResolver as never }],
    }), { workspace: "docs" })

    await agent.run!(context({ vertex: { model: "gemini" } }))

    expect(toolResolver).toHaveBeenCalledTimes(1)
    const resolvedShell = (agentSettings.at(-1)?.tools as { shell?: typeof shell } | undefined)?.shell
    expect(resolvedShell).toEqual(expect.objectContaining({
      inputSchema: { schema: {}, type: "json-schema" },
    }))
    await resolvedShell?.execute({ command: "rg defineAgent" })
    expect(shell.execute).toHaveBeenCalledWith({ command: "rg defineAgent" })
  })

  it("wraps default tool input schemas with the AI SDK schema helper", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const search = { execute: vi.fn() }

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
      capabilities: [{ id: "workspace-tools", tools: () => ({ search }) }],
    }), { workspace: "docs" })

    await agent.run!(context({ vertex: { model: "gemini" } }))

    const schemaJson = {
      additionalProperties: false,
      properties: {},
      type: "object",
    }
    expect(jsonSchema).toHaveBeenCalledWith(schemaJson)
    expect((agentSettings.at(-1)?.tools as { search?: { inputSchema?: unknown } } | undefined)?.search?.inputSchema).toEqual({
      schema: schemaJson,
      type: "json-schema",
    })
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      toolStepReporter: reportToolStep,
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: { sources: { docs: { cache: { maxAge: 60 }, source: {} } as never } },
      driver: { model: {} as never },
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      toolStepReporter: reportToolStep,
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

  it("materializes lazy workspace sources without Agent inspection reporting", async () => {
    const materialize = vi.fn(async () => ({ bytes: 12, directories: 1, durationMs: 3, files: 2, path: "", sources: [{ source: "docs", status: "ready" }] }))
    inspectTools.mockReturnValueOnce({
      materialize_sources: { execute: materialize },
    })
    const { defineAgent } = await import("../src/index.ts")

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: { sources: { docs: { cache: { maxAge: 60 }, source: {} } as never } },
      driver: { model: {} as never },
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

    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: { sources: { docs: { cache: { maxAge: 60 }, source: {} } as never } },
      driver: { model: {} as never },
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "docs" })

    await expect(agent.run!({
      ...(context() as Record<string, unknown>),
      toolStepReporter: reportToolStep,
    } as never)).resolves.toBe("ok")

    expect(agentGenerate).toHaveBeenCalledTimes(1)
    expect(reportToolStep.mock.calls[0]?.[0]).toMatchObject({
      toolCalls: [{ toolName: "materialize_sources" }],
    })
    expect(reportToolStep.mock.calls[1]?.[0]).toMatchObject({
      toolErrors: [{ output: "source unavailable", toolName: "materialize_sources" }],
    })
  })

  it("derives Agent inspection metadata from workspace agents", async () => {
    const { createAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const model = { modelId: "openai/gpt-test", provider: "openai" }
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          docs: { name: "docs" } as never,
        },
      },
      driver: {
        instructions: "Answer from the workspace.",
        model: model as never
      },
      version: "1.2.3",
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(createAgentInspectionMetadata(agent)).toEqual({
      config: {
        driver: {
          executionAuthority: noExecutionAuthority,
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

  it("inspects static and resolved UI message stream projection", async () => {
    const { createAgentInspectionMetadata, defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const staticAgent = defineAgent({
      driver: { run: () => "ok" },
      uiMessageStream: { reasoning: "hidden", tools: "full" },
    })
    const dynamicAgent = defineAgent({
      driver: { run: () => "ok" },
      uiMessageStream: ({ input }) => input.prompt === "private"
        ? { reasoning: "hidden", tools: "hidden" }
        : { reasoning: "visible", tools: "full" },
    })

    expect(createAgentInspectionMetadata(staticAgent).config?.uiMessageStream).toEqual({
      reasoning: "hidden",
      tools: "full",
    })
    expect(createAgentInspectionMetadata(dynamicAgent).config).not.toHaveProperty("uiMessageStream")
    expect((await resolveAgentInspectionMetadata(dynamicAgent, {
      input: { prompt: "private" },
    })).config?.uiMessageStream).toEqual({
      reasoning: "hidden",
      tools: "hidden",
    })
  })

  it("composes static Agent inspection instruction metadata", async () => {
    const { createAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        instructions: [
          "::if{context.enabled}",
          "Hidden.",
          "::else",
          "Answer from the workspace.",
          "::",
          "{{ context.missing }}",
        ].join("\n"),
        model: {} as never
      },
    }), { workspace: "support" })

    expect(createAgentInspectionMetadata(agent).instructions).toEqual([[
      "::if{context.enabled}",
      "Hidden.",
      "::else",
      "Answer from the workspace.",
      "::",
      "{{ context.missing }}",
    ].join("\n")])
  })

  it("keeps Channel guidance in materialized Agent inspection metadata", async () => {
    const { telegram } = await import("../src/channels.ts")
    const { defineAgent, materializeAgentInspectionSourceMetadata } = await import("../src/index.ts")
    const agent = withExplicitWorkspaceName(defineAgent({
      channels: { support: telegram() },
      workspace: {},
      driver: { model: {} as never },
    }), { workspace: "support" })

    expect((await materializeAgentInspectionSourceMetadata(agent)).instructions).toEqual(expect.arrayContaining([
      expect.stringContaining('Channel "support" instructions:\n\nWrite the final response for Telegram.'),
    ]))
  })

  it("keeps Capability metadata in static non-Workspace and materialized Workspace inspection", async () => {
    const { defineAgent, defineCapability, createAgentInspectionMetadata, materializeAgentInspectionSourceMetadata } = await import("../src/index.ts")
    const capability = defineCapability({ id: "inspectable", metadata: { status: "ready" } })
    const plainAgent = defineAgent({ capabilities: [capability], driver: { run: () => "ok" } })
    const workspaceAgent = withExplicitWorkspaceName(defineAgent({
      capabilities: [capability],
      driver: { model: {} as never },
      workspace: {},
    }), { workspace: "support" })

    expect(createAgentInspectionMetadata(plainAgent).capabilities).toEqual([
      { id: "inspectable", metadata: { status: "ready" } },
    ])
    expect((await materializeAgentInspectionSourceMetadata(workspaceAgent)).capabilities).toEqual([
      { id: "inspectable", metadata: { status: "ready" } },
    ])
  })

  it("keeps public Capability metadata from opaque Agent definitions", async () => {
    const { createAgentInspectionMetadata, defineCapability, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const agent = {
      capabilities: [defineCapability({ id: "inspectable", metadata: { status: "ready" } })],
      resolve: vi.fn(async () => ({ name: "opaque" })),
    } as never

    expect(createAgentInspectionMetadata(agent).capabilities).toEqual([
      { id: "inspectable", metadata: { status: "ready" } },
    ])
    await expect(resolveAgentInspectionMetadata(agent)).resolves.toMatchObject({
      capabilities: [{ id: "inspectable", metadata: { status: "ready" } }],
    })
  })

  it("always resolves Sources for materialized Agent inspection metadata", async () => {
    const { defineAgent, materializeAgentInspectionSourceMetadata } = await import("../src/index.ts")
    const agent = withExplicitWorkspaceName(defineAgent({
      driver: { model: {} as never },
      workspace: { sources: { docs: { resolve: vi.fn() } as never } },
    }), { workspace: "support" })

    await materializeAgentInspectionSourceMetadata(agent, { resolveSources: false } as never)

    expect(createWorkspaceSourceResolutionFacade).toHaveBeenCalledOnce()
  })

  it("includes skill sources in Agent inspection file metadata", async () => {
    const { createAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
      capabilities: [
        skills({
          path: "skills/agent-browser",
          source: {
            include: ["SKILL.md", "references/**", "templates/**"],
            materialize: "lazy",
            repo: "vercel/vercel-plugin",
            root: "skills/agent-browser",
          } as never,
        }),
      ],
    }), { workspace: "support" })

    expect(createAgentInspectionMetadata(agent).files).toContainEqual({
      kind: "directory",
      label: "agent-browser",
      materialize: "lazy",
      materialized: false,
      path: "skills/agent-browser",
      source: "skill.agent-browser",
      status: "lazy",
    })
  })

  it("adds controlled curl to resolved Agent inspection metadata when source request descriptors are visible", async () => {
    list.mockImplementation(async path => path === ".vitehub/sources"
      ? [{ path: ".vitehub/sources/inventoryHealthSummary.json", type: "file" }]
      : [])
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const { workspaceShell } = await import("../src/capabilities.ts")
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: {} as never },
      capabilities: [workspaceShell()],
    }), { workspace: "support" })

    expect(await resolveAgentInspectionMetadata(agent)).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          commands: ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc", "curl"],
          name: "workspaceShell",
        }),
      ]),
    })
  })

  it("resolves invocation-selected Capabilities for Agent inspection metadata", async () => {
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const { workspaceShell } = await import("../src/capabilities.ts")
    const resolveCapabilities = vi.fn(({ actor, context, driver }) => {
      expect(actor.kind).toBe("inspection")
      expect(driver.kind).toBe("model")
      return context.get("workspaceShellEnabled") ? [workspaceShell()] : []
    })
    const agent = withExplicitWorkspaceName(defineAgent({
      capabilities: resolveCapabilities,
      driver: { model: {} as never },
      workspace: {},
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent, {
      input: {
        context: {
          invoker: { id: "inspection", kind: "inspection" },
          workspaceShellEnabled: true,
        },
      },
    })

    expect(resolveCapabilities).toHaveBeenCalledOnce()
    expect(metadata.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "workspaceShell" }),
    ]))
  })

  it("resolves invocation-selected Capabilities for non-Workspace Agent inspection metadata", async () => {
    const { defineAgent, defineCapability, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const selected = defineCapability({
      id: "selected",
      tools: { selected: { name: "selected" } },
    })
    const resolveCapabilities = vi.fn(({ actor, context, driver }) => {
      expect(actor.kind).toBe("inspection")
      expect(driver.kind).toBe("run")
      return context.get("selectedEnabled") ? [selected] : []
    })
    const agent = defineAgent({
      capabilities: resolveCapabilities,
      driver: { run: () => "ok" },
    })

    const metadata = await resolveAgentInspectionMetadata(agent, {
      input: {
        context: {
          invoker: { id: "inspection", kind: "inspection" },
          selectedEnabled: true,
        },
      },
    })

    expect(resolveCapabilities).toHaveBeenCalledOnce()
    expect(metadata.tools).toEqual([
      expect.objectContaining({ name: "selected" }),
    ])
  })

  it("returns stable redacted metadata from inspection-selected Capabilities and cleans them up", async () => {
    const { defineAgent, defineCapability, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const close = vi.fn()
    const prepare = vi.fn()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const inspectable = defineCapability({
      close,
      id: "alpha",
      metadata: {
        zeta: true,
        auth: "auth-value",
        apiKey: "api-key-value",
        array: [1, undefined, Number.POSITIVE_INFINITY, "ok"],
        authorizationHeader: "authorization-value",
        circular,
        cookie: "cookie-value",
        credentialSource: "credential-value",
        AUTHTOKEN: "auth-token-value",
        CREDENTIALSOURCE: "credential-source-value",
        nested: { token: "token-value", visible: "yes" },
        privateKey: "private-key-value",
        sessionCookie: "session-cookie-value",
        SESSIONCOOKIE: "session-cookie-uppercase-value",
        sessionId: "session-id-value",
        signingKey: "signing-key-value",
        SSHPrivateKey: "ssh-private-key-value",
        unsupported: new Date(),
      },
      prepare,
    })
    const agent = defineAgent({
      capabilities: ({ actor }) => {
        expect(actor.kind).toBe("inspection")
        return [defineCapability({ id: "zeta", metadata: { status: "ready" } }), inspectable]
      },
      driver: { run: () => "ok" },
    })

    const metadata = await resolveAgentInspectionMetadata(agent, {
      input: { context: { invoker: { id: "inspection", kind: "inspection" } } },
    })

    expect(metadata.capabilities?.map(capability => capability.id)).toEqual(["alpha", "zeta"])
    expect(Object.keys(metadata.capabilities?.[0]?.metadata || {})).toEqual([
      "AUTHTOKEN",
      "CREDENTIALSOURCE",
      "SESSIONCOOKIE",
      "SSHPrivateKey",
      "apiKey",
      "array",
      "auth",
      "authorizationHeader",
      "cookie",
      "credentialSource",
      "nested",
      "privateKey",
      "sessionCookie",
      "sessionId",
      "signingKey",
      "zeta",
    ])
    expect(metadata.capabilities?.[0]?.metadata).toMatchObject({
      apiKey: "[redacted]",
      AUTHTOKEN: "[redacted]",
      array: [1, "ok"],
      auth: "[redacted]",
      authorizationHeader: "[redacted]",
      cookie: "[redacted]",
      credentialSource: "[redacted]",
      CREDENTIALSOURCE: "[redacted]",
      nested: { token: "[redacted]", visible: "yes" },
      privateKey: "[redacted]",
      sessionCookie: "[redacted]",
      SESSIONCOOKIE: "[redacted]",
      sessionId: "[redacted]",
      signingKey: "[redacted]",
      SSHPrivateKey: "[redacted]",
    })
    expect(metadata.capabilities?.[0]?.metadata).not.toHaveProperty("circular")
    expect(metadata.capabilities?.[0]?.metadata).not.toHaveProperty("unsupported")
    expect(prepare).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("rejects impossible invocation-selected Capabilities in non-Workspace Agent inspection metadata", async () => {
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const { workspaceShell } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: () => [workspaceShell()],
      driver: { run: () => "ok" },
    })

    await expect(resolveAgentInspectionMetadata(agent)).rejects.toThrow(
      "workspaceShell() requires an explicit workspace",
    )
  })

  it("does not resolve a dynamic model to inspect non-Workspace execution authority", async () => {
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const resolveModel = vi.fn(() => ({ modelId: "test/model", provider: "test" }))
    const agent = defineAgent({ driver: { model: resolveModel as never } })

    const metadata = await resolveAgentInspectionMetadata(agent)

    expect(resolveModel).not.toHaveBeenCalled()
    expect(metadata.config?.driver).toMatchObject({
      executionAuthority: noExecutionAuthority,
      kind: "model",
      model: { dynamic: true },
    })
  })

  it("reports no provider execution authority on processless runtimes", async () => {
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const agent = defineAgent({ driver: "codex" })

    const metadata = await resolveAgentInspectionMetadata(agent, { runtime: { runtime: "deno" } })

    expect(metadata.config?.driver).toMatchObject({
      executionAuthority: noExecutionAuthority,
      kind: "provider",
    })
  })

  it("preserves configured provider models in Agent inspection metadata", async () => {
    const { createAgentInspectionMetadata, defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const agent = defineAgent({ driver: { kind: "codex", model: "gpt-5.6-sol" } })

    expect(createAgentInspectionMetadata(agent).config?.driver.provider?.model).toBe("gpt-5.6-sol")
    expect((await resolveAgentInspectionMetadata(agent)).config?.driver.provider?.model).toBe("gpt-5.6-sol")
  })

  it("reports unknown authority for an opaque custom Agent definition", async () => {
    const { createAgentInspectionMetadata, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const agent = {
      async resolve() {
        return { name: "opaque" }
      },
    } as never

    expect(createAgentInspectionMetadata(agent).config?.driver).toEqual({
      executionAuthority: unknownExecutionAuthority,
      kind: "unknown",
    })
    expect((await resolveAgentInspectionMetadata(agent)).config?.driver.executionAuthority)
      .toBe(unknownExecutionAuthority)
  })

  it("reports unknown authority for custom run drivers", async () => {
    const { createAgentInspectionMetadata, defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const agent = defineAgent({ driver: { run: () => "ok" } })

    expect(createAgentInspectionMetadata(agent).config?.driver).toEqual({
      executionAuthority: unknownExecutionAuthority,
      kind: "run",
    })
    expect((await resolveAgentInspectionMetadata(agent)).config?.driver).toEqual({
      executionAuthority: unknownExecutionAuthority,
      kind: "run",
    })
  })

  it("closes prepared Capabilities after Agent inspection metadata success and failure", async () => {
    const { defineAgent, defineCapability, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const close = vi.fn()
    const prepare = vi.fn()
    const capability = defineCapability({ close, id: "metadata-resource", prepare })
    const createAgent = (model: unknown) => withExplicitWorkspaceName(defineAgent({
      capabilities: [capability],
      driver: { model: model as never },
      workspace: {},
    }), { workspace: "support" })

    await expect(resolveAgentInspectionMetadata(createAgent({}))).resolves.toBeDefined()
    expect(prepare).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()

    const failure = new Error("model metadata failed")
    await expect(resolveAgentInspectionMetadata(createAgent(() => { throw failure }))).rejects.toBe(failure)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it("applies invocation-selected Workspace Access without resolving Sources when Source resolution is disabled", async () => {
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    const resolveSource = vi.fn(() => false)
    const resolveCapabilities = vi.fn(() => [
      access({
        workspace: {
          resolve: { role: "admin", scope: "all" },
          scopes: { all: { all: true } },
        },
      }),
    ])
    const agent = withExplicitWorkspaceName(defineAgent({
      capabilities: resolveCapabilities,
      driver: { model: {} as never },
      workspace: {
        sources: {
          docs: {
            getItem: vi.fn(),
            getKeys: vi.fn(),
            resolve: resolveSource,
          } as never,
        },
      },
    }), { workspace: "support" })

    await expect(resolveAgentInspectionMetadata(agent, { resolveSources: false })).resolves.toBeDefined()
    expect(resolveCapabilities).toHaveBeenCalledOnce()
    expect(list).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(resolveSource).not.toHaveBeenCalled()
    expect(createWorkspaceSourceResolutionFacade).not.toHaveBeenCalled()
  })

  it("does not invoke dynamic Source resolvers when Source resolution is disabled", async () => {
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const resolveSource = vi.fn(() => false)
    const agent = withExplicitWorkspaceName(defineAgent({
      driver: { model: {} as never },
      workspace: {
        sources: {
          docs: {
            getItem: vi.fn(),
            getKeys: vi.fn(),
            resolve: resolveSource,
          } as never,
        },
      },
    }), { workspace: "support" })

    await expect(resolveAgentInspectionMetadata(agent, { resolveSources: false })).resolves.toBeDefined()
    expect(resolveSource).not.toHaveBeenCalled()
    expect(createWorkspaceSourceResolutionFacade).not.toHaveBeenCalled()
  })

  it("does not invoke Capability-contributed Source resolvers when Source resolution is disabled", async () => {
    const { defineAgent, defineCapability, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const resolveSource = vi.fn(() => false)
    const agent = withExplicitWorkspaceName(defineAgent({
      capabilities: [defineCapability({
        id: "dynamic-source",
        workspace: {
          sources: {
            contributed: {
              getItem: vi.fn(),
              getKeys: vi.fn(),
              resolve: resolveSource,
            } as never,
          },
        },
      })],
      driver: { model: {} as never },
      workspace: {},
    }), { workspace: "support" })

    await expect(resolveAgentInspectionMetadata(agent, { resolveSources: false })).resolves.toBeDefined()
    expect(resolveSource).not.toHaveBeenCalled()
    expect(createWorkspaceSourceResolutionFacade).not.toHaveBeenCalled()
  })

  it("keeps static instruction coverage warnings when Source resolution is disabled", async () => {
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const { workspaceShell } = await import("../src/capabilities.ts")
    const agent = withExplicitWorkspaceName(defineAgent({
      capabilities: [workspaceShell()],
      driver: { instructions: "Answer from the workspace.", model: {} as never },
      workspace: {},
    }), { workspace: "support" })

    await expect(resolveAgentInspectionMetadata(agent, { resolveSources: false })).resolves.toMatchObject({
      warnings: [expect.objectContaining({ id: "instruction-coverage:capability:workspace-shell" })],
    })
  })

  it("does not infer coverage warnings from unresolved dynamic instructions", async () => {
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const { workspaceShell } = await import("../src/capabilities.ts")
    const agent = withExplicitWorkspaceName(defineAgent({
      capabilities: [workspaceShell()],
      driver: { instructions: async () => "::capability{name=\"workspace-shell\"}\nInspect files.\n::", model: {} as never },
      workspace: {},
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent, { resolveSources: false })
    expect(metadata.warnings).toBeUndefined()
  })

  it("does not resolve Workspace-backed instructions when Source resolution is disabled", async () => {
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const readInstructions = vi.fn(async ({ fs }) => await fs.readFile("docs/AGENTS.md"))
    const agent = withExplicitWorkspaceName(defineAgent({
      driver: { instructions: readInstructions, model: {} as never },
      workspace: { sources: { docs: { name: "docs" } as never } },
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent, { resolveSources: false })

    expect(readInstructions).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(metadata.instructions).toEqual(["Dynamic system instructions resolver configured."])
  })

  it("does not probe local Workspace instructions when Source resolution is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-source-free-inspection-"))
    tempRoots.push(root)
    const workspaceRoot = join(root, ".vitehub", "workspaces", "support")
    await mkdir(join(workspaceRoot, "docs"), { recursive: true })
    await writeLocalFile(join(workspaceRoot, "AGENTS.md"), "Private Workspace instructions.\n")
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root)
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const agent = withExplicitWorkspaceName(defineAgent({
      driver: { instructions: async () => "Dynamic instructions.", model: {} as never },
      workspace: { sources: { docs: { name: "docs" } as never } },
    }), { workspace: "support" })

    try {
      const metadata = await resolveAgentInspectionMetadata(agent, { resolveSources: false })
      expect(metadata.instructions).toEqual(["Dynamic system instructions resolver configured."])
    }
    finally {
      cwd.mockRestore()
    }
  })

  it("uses embedded colocated instructions without host filesystem access", async () => {
    const getBuiltinModule = vi.spyOn(process, "getBuiltinModule").mockReturnValue(undefined)
    const { defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const { workspaceAgentWithSourceRoot } = await import("../src/workspace-agent.ts")
    const agent = workspaceAgentWithSourceRoot(withExplicitWorkspaceName(defineAgent({
      driver: { model: {} as never },
      workspace: {},
    }), { workspace: "support" }), "/unavailable", "Use embedded instructions.\n")

    try {
      await expect(resolveAgentInspectionMetadata(agent, { resolveSources: false })).resolves.toMatchObject({
        instructions: ["Use embedded instructions."],
      })
    }
    finally {
      getBuiltinModule.mockRestore()
    }
  })

  it("resolves dynamic model metadata for Agent inspection", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const abortSignal = new AbortController().signal
    const resolveModel = vi.fn((context: { abortSignal?: AbortSignal, channel?: { meta?: { customer?: string } }, invoker: { kind?: string } }) => ({
      modelId: `test/${context.invoker.kind || "unknown"}/${context.channel?.meta?.customer || "unknown"}`,
      provider: "test",
    }))
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { model: resolveModel as never },
    }), { workspace: "support" })

    expect(await resolveAgentInspectionMetadata(agent, {
      input: {
        abortSignal,
        context: {
          channel: { meta: { customer: "acme" } },
          invoker: {
            id: "inspection",
            kind: "inspection",
          },
        },
      },
    })).toMatchObject({
      config: {
        driver: {
          kind: "model",
          model: {
            dynamic: true,
            id: "test/inspection/acme",
            provider: "test",
          },
        },
      },
    })
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal,
      channel: { meta: { customer: "acme" } },
    }))
  })

  it("marks dynamic Agent inspection instruction metadata without resolving it", async () => {
    const { createAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const readInstructions = vi.fn(async () => "Workspace instructions")
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        instructions: readInstructions,
        model: {} as never
      },
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(createAgentInspectionMetadata(agent).instructions).toEqual(["Dynamic system instructions resolver configured."])
    expect(readInstructions).not.toHaveBeenCalled()
  })

  it("resolves dynamic Agent inspection instruction metadata", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const readInstructions = vi.fn(async ({ fs }) => await fs.readFile("AGENTS.md"))
    readFile.mockResolvedValue("# Workspace instructions\n")
    exists.mockResolvedValue(true)
    list.mockResolvedValue([{ path: "AGENTS.md", type: "file" }])
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: {
        instructions: readInstructions,
        model: {} as never
      },
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(await resolveAgentInspectionMetadata(agent)).toMatchObject({
      files: [{
        kind: "file",
        label: "AGENTS.md",
        path: "AGENTS.md",
      }],
      instructions: ["# Workspace instructions"],
    })
    expect(readInstructions).toHaveBeenCalledOnce()
  })

  it("warns model drivers when configured primitives lack explicit instruction coverage", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const { skills, workspaceShell } = await import("../src/capabilities.ts")
    exists.mockResolvedValue(true)
    list.mockResolvedValue([{ path: "AGENTS.md", type: "file" }])
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          docs: { name: "docs" } as never,
        },
      },
      driver: {
        instructions: "Answer from the workspace.",
        model: {} as never,
      },
      capabilities: [workspaceShell(), skills({ path: "skills/review-browser-evidence" })],
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent)
    expect(metadata.instructions).toEqual(["Answer from the workspace."])
    expect(metadata.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "instruction-coverage:source:docs", primitive: "source" }),
      expect.objectContaining({ id: "instruction-coverage:capability:workspace-shell", primitive: "capability" }),
      expect.objectContaining({ id: "instruction-coverage:skill:skills/review-browser-evidence", primitive: "skill" }),
    ]))
  })

  it("warns run drivers when configured skills lack explicit instruction coverage", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const { skills } = await import("../src/capabilities.ts")
    exists.mockResolvedValue(true)
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      driver: { run: () => "done" },
      capabilities: [skills({ path: "skills/review-browser-evidence" })],
    }), { workspace: "support" })

    expect(await resolveAgentInspectionMetadata(agent)).toMatchObject({
      warnings: [expect.objectContaining({ id: "instruction-coverage:skill:skills/review-browser-evidence", primitive: "skill" })],
    })
  })

  it("clears instruction coverage warnings with explicit coverage blocks", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const { skills, workspaceShell } = await import("../src/capabilities.ts")
    const readInstructions = vi.fn(async ({ fs }) => await fs.readFile("AGENTS.md"))
    readFile.mockResolvedValue([
      "# Workspace instructions",
      "",
      "::source{key=\"docs\"}",
      "Use docs for support evidence.",
      "::",
      "",
      "::capability{key=\"workspaceShell\"}",
      "Use workspace shell for explicit file inspection.",
      "::",
      "",
      "::skill{path=\"skills/review-browser-evidence\"}",
      "Use browser evidence for bounded review claims.",
      "::",
    ].join("\n"))
    exists.mockResolvedValue(true)
    list.mockResolvedValue([{ path: "AGENTS.md", type: "file" }])
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          docs: { name: "docs" } as never,
        },
      },
      driver: {
        instructions: readInstructions,
        model: {} as never,
      },
      capabilities: [workspaceShell(), skills({ path: "skills/review-browser-evidence" })],
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent)
    expect(metadata.instructions).toEqual([[
      "# Workspace instructions",
      "Use docs for support evidence.",
      "Use workspace shell for explicit file inspection.",
      "Use browser evidence for bounded review claims.",
    ].join("\n\n")])
    expect(metadata.warnings).toBeUndefined()
    expect(readInstructions).toHaveBeenCalledOnce()
  })

  it("resolves prepare-scoped capability metadata while resolving Agent inspection metadata", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const phase = vi.fn()
    const toolResolver = vi.fn(() => ({}))
    const invokerResolve = vi.fn(() => ({ id: "resolved" }))
    exists.mockResolvedValue(true)
    list.mockResolvedValue([{ path: "docs/guide.md", type: "file" }])
    readFile.mockResolvedValue([
      "# Workspace instructions",
      "",
      "::source{key=\"docs\"}",
      "Use docs for support evidence.",
      "::",
      "",
      "::capability{key=\"tracked\"}",
      "Use tracked capability metadata.",
      "::",
    ].join("\n"))
    const agent = withExplicitWorkspaceName(defineAgent({
      invoker: {
        profiles: [{ id: "support", kind: "support", label: "Support" }],
        resolve: invokerResolve,
      },
      workspace: {
        sources: {
          docs: { name: "docs" } as never,
        },
      },
      driver: {
        instructions: async ({ fs }) => await fs.readFile("AGENTS.md"),
        model: {} as never
      },
      hooks: {
        "capability:prepare": () => phase("hook:prepare"),
      },
      capabilities: [{
        bind: () => phase("bind"),
        close: () => phase("close"),
        configure: () => phase("configure"),
        id: "tracked",
        input: () => phase("input"),
        output: () => phase("output"),
        prepare: () => phase("prepare"),
        resolve: () => phase("resolve"),
        tools: toolResolver,
      }],
    }), { workspace: "support" })

    expect(await resolveAgentInspectionMetadata(agent, {
      input: { context: { invokerProfileId: "support" } },
    })).toMatchObject({
      files: [expect.objectContaining({ path: "docs" })],
      instructions: [[
        "# Workspace instructions",
        "Use docs for support evidence.",
        "Use tracked capability metadata.",
      ].join("\n\n")],
      tools: [expect.objectContaining({ name: "tracked" })],
    })
    expect(phase.mock.calls.map(call => call[0])).toEqual(["hook:prepare", "prepare", "close"])
    expect(toolResolver).not.toHaveBeenCalled()
    expect(invokerResolve).toHaveBeenCalledOnce()
  })

  it("resolves recursive Agent inspection file metadata for lazy source entries", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    list.mockResolvedValue([
      { path: "docs/guides", type: "directory" },
      { path: "docs/guides/start.md", type: "file" },
    ])
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          docs: { cache: { maxAge: 60 }, mount: "docs", name: "docs" } as never,
        },
      },
      driver: {
        instructions: "Answer from the workspace.",
        model: {} as never
      },
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(await resolveAgentInspectionMetadata(agent)).toMatchObject({
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

  it("applies Access-scoped workspace visibility during Agent inspection metadata resolution", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
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
    const agent = withExplicitWorkspaceName(defineAgent({
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
      driver: {
        instructions: "Answer from the workspace.",
        model: {} as never
      },
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent, {
      input: { context: { invokerProfileId: "customer" } },
    })
    const paths = JSON.stringify(metadata.files)

    expect(paths).toContain("customers/acme/orders.sql")
    expect(paths).not.toContain("customers/globex")
    expect(paths).not.toContain("portal")
    expect(resolveScope).toHaveBeenCalledOnce()
    expect(createWorkspaceSourceResolutionFacade).toHaveBeenCalledOnce()
  })

  it("applies Access-scoped Source visibility without resolving Sources", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          customers: { mount: "customers", name: "customers" } as never,
          portal: { mount: "portal", name: "portal" } as never,
        },
      },
      capabilities: [access({
        workspace: {
          defaultScope: "customer",
          scopes: { customer: { paths: ["customers/acme"] } },
        },
      })],
      driver: { model: {} as never },
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent, { resolveSources: false })
    expect(metadata.files?.map(file => file.source)).toEqual(["customers"])
    expect(createWorkspaceSourceResolutionFacade).not.toHaveBeenCalled()
  })

  it("applies Access-scoped Source probe visibility without resolving Sources", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          public: { mount: "", name: "public", probeKeys: ["public/guide.md"] } as never,
          private: { mount: "", name: "private", probeKeys: ["private/guide.md"] } as never,
        },
      },
      capabilities: [access({
        workspace: {
          defaultScope: "public",
          scopes: { public: { paths: ["public"] } },
        },
      })],
      driver: { model: {} as never },
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent, { resolveSources: false })
    expect(metadata.files?.map(file => file.source)).toEqual(["public"])
    expect(createWorkspaceSourceResolutionFacade).not.toHaveBeenCalled()
  })

  it("clears Source coverage warnings after Access source resolution for Agent inspection metadata", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    exists.mockImplementation(async path => path === "ingestion/acme")
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          ingestion: {
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
      driver: {
        instructions: [
          "Answer from the workspace.",
          "",
          "::source{key=\"ingestion\"}",
          "Use this source for ingestion models.",
          "::",
          "",
          "::capability{key=\"access\"}",
          "Use Access for scoped workspace visibility.",
          "::",
        ].join("\n"),
        model: {} as never,
      },
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent)
    expect(metadata.instructions).toEqual([[
      "Answer from the workspace.",
      "Use this source for ingestion models.",
      "Use Access for scoped workspace visibility.",
    ].join("\n\n")])
    expect(metadata.warnings).toBeUndefined()
    expect(createWorkspaceSourceResolutionFacade).toHaveBeenCalledOnce()
  })

  it("clears Capability Workspace Contribution source coverage in resolved Agent inspection metadata", async () => {
    const { resolveAgentInspectionMetadata, defineAgent, defineCapability } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
    exists.mockResolvedValue(false)
    list.mockResolvedValue([])
    useWorkspace.mockReturnValueOnce(readonlyWorkspaceFacade())
    const metadataWorkspace = readonlyWorkspaceFacade()
    metadataWorkspace.fs.exists = vi.fn(async path => path === "pull-request")
    createWorkspaceSourceResolutionFacade.mockImplementationOnce(async (workspace, definition) => ({
      definition: { ...(definition as object) },
      workspace,
    }))
    createWorkspaceSourceResolutionFacade.mockImplementationOnce(async (_workspace, definition) => ({
      definition,
      workspace: metadataWorkspace,
    }))
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {},
      capabilities: [
        access({
          workspace: {
            resolve: { role: "admin", scope: "review" },
            scopes: {
              review: { all: true },
            },
          },
        }),
        defineCapability({
          id: "review-context",
          workspace: () => ({
            sources: {
              pullRequest: {
                mount: "pull-request",
                async getKeys() {
                  return []
                },
                async getItem(key: string) {
                  return { content: "", key }
                },
              },
            },
          }),
        }),
      ],
      driver: {
        instructions: [
          "Answer from the workspace.",
          "",
          "::capability{key=\"access\"}",
          "Use Access for review scope.",
          "::",
          "",
          "::capability{key=\"reviewContext\"}",
          "Use pull request context for review metadata.",
          "::",
          "",
          "::source{key=\"pullRequest\"}",
          "Use this source for pull-request review material.",
          "::",
        ].join("\n"),
        model: {} as never,
      },
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent)
    expect(metadata.instructions).toEqual([[
      "Answer from the workspace.",
      "Use Access for review scope.",
      "Use pull request context for review metadata.",
      "Use this source for pull-request review material.",
    ].join("\n\n")])
    expect(metadata.warnings).toBeUndefined()
  })

  it("flattens virtual workspace AGENTS.md while keeping sibling instruction files", async () => {
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    list.mockResolvedValue([
      { path: "forecasting-engine", type: "directory" },
      { path: "ingestion", type: "directory" },
      { path: "instructions", type: "directory" },
      { path: "instructions/AGENTS.md", type: "file" },
      { path: "instructions/private.md", type: "file" },
    ])
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          "forecasting-engine": { name: "forecasting-engine" } as never,
          ingestion: { name: "ingestion" } as never,
        },
      },
      driver: {
        instructions: "Answer from the workspace.",
        model: {} as never
      },
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    const metadata = await resolveAgentInspectionMetadata(agent)
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
    const { resolveAgentInspectionMetadata, defineAgent } = await import("../src/index.ts")
    list.mockResolvedValue([
      { mtime: 1710000000000, path: "docs/guides/start.md", size: 128, type: "file" },
    ])
    const agent = withExplicitWorkspaceName(defineAgent({
      workspace: {
        sources: {
          docs: { cache: { maxAge: 60 }, mount: "docs", name: "docs" } as never,
        },
      },
      driver: {
        instructions: "Answer from the workspace.",
        model: {} as never
      },
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), { workspace: "support" })

    expect(await resolveAgentInspectionMetadata(agent)).toMatchObject({
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
