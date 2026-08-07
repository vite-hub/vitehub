import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"
import { parseAst } from "vite"

import { eveExtensionCapability } from "../src/eve.ts"
import { hubAgent } from "../src/vite.ts"

import type { AgentCapabilityContext, AgentToolDefinition } from "../src/types.ts"
import type { ModelMessage } from "ai"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

function capabilityContext(): AgentCapabilityContext {
  const messages = () => []
  return {
    actor: { id: "test" },
    context: {} as never,
    fs: {} as never,
    invocation: {
      input: {
        get: () => ({}),
        messages,
        set: () => {},
        setMessages: () => {},
      },
    },
    invoker: { id: "test" },
    memo: (() => {}) as never,
    run: { runId: "run-1" },
    runtime: "unknown",
    waitUntil: () => {},
    workspace: {} as never,
  }
}

describe("Eve extension capabilities", () => {
  it("detects the published GitHub Tools extension in a static capabilities array", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-eve-extension-"))
    temporaryDirectories.push(root)
    const plugin = hubAgent()
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      command: "serve",
      createResolver: () => async (specifier: string) => fileURLToPath(import.meta.resolve(specifier)),
      plugins: [],
      root,
    })
    const source = [
      `import github from "@github-tools/eve-extension"`,
      `export default defineAgent({ capabilities: [github({ preset: "code-review" })] })`,
    ].join("\n")
    const id = join(root, "server", "agents", "reviewer.ts")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      id,
    )

    expect(transformed).toContain(`from "@vite-hub/agent/eve"`)
    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
    expect(transformed).not.toContain(`import github from`)

    await expect((plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "other.ts"),
    )).rejects.toThrow("can only be mounted once per Vite app")

    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: id,
      server: {
        config: { root },
        moduleGraph: { getModuleById: () => undefined },
      },
    })
    await expect((plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "other.ts"),
    )).resolves.toContain(`from "@vite-hub/agent/eve"`)
  })

  it("loads GitHub tools and preserves once-per-session approval", async () => {
    const capability = await eveExtensionCapability(
      "@github-tools/eve-extension",
      "github",
      async () => await import("@github-tools/eve-extension") as unknown as Record<string, unknown>,
      async () => await import("@github-tools/eve-extension/tools") as unknown as Record<string, unknown>,
      {
        include: ["getFileContent", "createOrUpdateFile"],
        requireApproval: { createOrUpdateFile: "once" },
        token: "test-token",
      },
    )
    expect(typeof capability.tools).toBe("function")
    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext())
    const read = tools.github__getFileContent as AgentToolDefinition & { toModelOutput?: unknown }
    const write = tools.github__createOrUpdateFile as AgentToolDefinition & {
      needsApproval: (input: unknown, options: { messages: ModelMessage[], toolCallId: string }) => Promise<boolean>
    }

    expect(read).toMatchObject({ name: "github__getFileContent" })
    expect(typeof read.toModelOutput).toBe("function")
    expect(await write.needsApproval({}, { messages: [], toolCallId: "call-1" })).toBe(true)

    const messages = [
      {
        content: [
          { input: {}, toolCallId: "call-1", toolName: "github__createOrUpdateFile", type: "tool-call" },
          { approvalId: "approval-1", toolCallId: "call-1", type: "tool-approval-request" },
        ],
        role: "assistant",
      },
      {
        content: [{ approvalId: "approval-1", approved: true, type: "tool-approval-response" }],
        role: "tool",
      },
    ] as ModelMessage[]
    expect(await write.needsApproval({}, { messages, toolCallId: "call-2" })).toBe(false)
  })
})
