import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"
import { parseAst } from "vite"

import { toAiSdkModelMessages } from "../src/ai-sdk.ts"
import { eveExtensionCapability } from "../src/eve.ts"
import { hubAgent, transformEveExtensionCapabilities } from "../src/vite.ts"

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
      `import { defineAgent } from "@vite-hub/agent"`,
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

    const watcherHandlers = new Map<string, (file: string) => void>()
    ;(plugin.config as unknown as (config: { agent: boolean }) => void)({ agent: false })
    await (plugin.configureServer as (server: unknown) => Promise<void>)({
      middlewares: { use: () => {} },
      watcher: { on: (event: string, handler: (file: string) => void) => watcherHandlers.set(event, handler) },
    })
    ;(plugin.config as unknown as (config: { agent: Record<string, never> }) => void)({ agent: {} })
    const otherId = join(root, "server", "agents", "other.ts")
    watcherHandlers.get("unlink")?.(otherId)
    await expect((plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      id,
    )).resolves.toContain(`from "@vite-hub/agent/eve"`)
  })

  it("detects Eve extensions in a factored static capabilities array", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `const capabilities = [github({ preset: "code-review" })]`,
      `export default defineAgent({ capabilities })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
    expect(transformed).not.toContain(`import github from`)
  })

  it("only lowers capabilities on an Agent Definition", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `const provider = { capabilities: [github()] }`,
      `export default defineAgent({ capabilities: [], metadata: { provider } })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toBeUndefined()
  })

  it("does not lower calls to an unrelated defineAgent binding", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import github from "@github-tools/eve-extension"
        function defineAgent(options) { return options }
        export default defineAgent({ capabilities: [github()] })
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
  })

  it("detects Eve extensions in factored Agent Definition options", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `const options = { capabilities: [github()] }`,
      `export default defineAgent(options)`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
  })

  it("detects Eve extensions in spread-composed Agent Definition options", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `const base = { capabilities: [github()] }`,
      `export default defineAgent({ ...base, driver: { run: () => "ok" } })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
  })

  it("detects Eve extensions through an aliased defineAgent import", async () => {
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
      `import { defineAgent as agent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `export default agent({ capabilities: [github()] })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
  })

  it("derives the Eve namespace from the package instead of its local alias", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import $github from "@github-tools/eve-extension"`,
      `export default defineAgent({ capabilities: [$github()] })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`"@github-tools/eve-extension", "github"`)
    expect(transformed).not.toContain(`"$github"`)
  })

  it("includes package scopes when extension basenames collide", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import one from "@one/foo-extension"
        import two from "@two/foo-extension"
        export default defineAgent({ capabilities: [one(), two()] })
      `,
      parseAst,
      async specifier => specifier.endsWith("/foo-extension"),
    )

    expect(transformed).toContain('EveExtensionCapability("@one/foo-extension", "one-foo"')
    expect(transformed).toContain('EveExtensionCapability("@two/foo-extension", "two-foo"')
  })

  it("detects a default Eve factory imported with named imports", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github, { defineConfig } from "@github-tools/eve-extension"`,
      `const config = defineConfig({})`,
      `export default defineAgent({ capabilities: [github(config)] })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
    expect(transformed).toContain(`import github, { defineConfig }`)
  })

  it("detects Eve extensions in an exported static capabilities array", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `export const capabilities = [github()]`,
      `export default defineAgent({ capabilities })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
  })

  it("lowers an exported static capabilities array imported by an Agent Definition", async () => {
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
      `export const capabilities = [github()]`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "capabilities.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
  })

  it("does not count same-named metadata keys as Eve factory uses", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `export default defineAgent({ capabilities: [github()], metadata: { github: true } })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
  })

  it("does not count same-named member properties as Eve factory uses", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `const provider = integrations.github`,
      `export default defineAgent({ capabilities: [github()], metadata: { provider } })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
  })

  it("retains an Eve import used by a shadowed binding", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `function inspect(github) { return github }`,
      `export default defineAgent({ capabilities: [github()], metadata: { inspect } })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
    expect(transformed).toContain(`import github from "@github-tools/eve-extension"`)
  })

  it("detects Eve extensions in a spread static capabilities array", async () => {
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
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `const base = [github({ preset: "code-review" })]`,
      `export default defineAgent({ capabilities: [...base] })`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
    expect(transformed).not.toContain(`import github from`)
  })

  it("detects Eve extensions in typed static capabilities arrays", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-eve-extension-"))
    temporaryDirectories.push(root)
    const plugin = hubAgent()
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      command: "serve",
      createResolver: () => async (specifier: string) => fileURLToPath(import.meta.resolve(specifier)),
      plugins: [],
      root,
    })
    const inline = [
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `export default defineAgent({ capabilities: [github()] })`,
    ].join("\n")
    const parseWithWrapper = (code: string, wrapper: "TSAsExpression" | "TSSatisfiesExpression", target: "property" | "variable") => {
      const ast = parseAst(code) as unknown as Record<string, unknown>
      const visit = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return false
        const node = value as Record<string, unknown>
        const expression = target === "property" && node.type === "Property" && (node.key as { name?: unknown })?.name === "capabilities"
          ? node.value
          : target === "variable" && node.type === "VariableDeclarator" && (node.id as { name?: unknown })?.name === "capabilities"
            ? node.init
            : undefined
        if (expression && typeof expression === "object") {
          const positioned = expression as { end: number, start: number }
          const wrapped = { end: positioned.end, expression, start: positioned.start, type: wrapper }
          if (target === "property") node.value = wrapped
          else node.init = wrapped
          return true
        }
        return Object.values(node).some(child => Array.isArray(child) ? child.some(visit) : visit(child))
      }
      visit(ast)
      return ast
    }
    await expect((plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: (code: string) => parseWithWrapper(code, "TSAsExpression", "property") },
      inline,
      join(root, "server", "agents", "inline.ts"),
    )).resolves.toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)

    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: join(root, "server", "agents", "inline.ts"),
      server: { config: { root }, moduleGraph: { getModuleById: () => undefined } },
    })
    const factored = [
      `import { defineAgent } from "@vite-hub/agent"`,
      `import github from "@github-tools/eve-extension"`,
      `const capabilities = [github()]`,
      `export default defineAgent({ capabilities })`,
    ].join("\n")
    await expect((plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: (code: string) => parseWithWrapper(code, "TSSatisfiesExpression", "variable") },
      factored,
      join(root, "server", "agents", "factored.ts"),
    )).resolves.toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "github"`)
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

    const messages = toAiSdkModelMessages([
      {
        id: "message-1",
        parts: [
          { id: "call-1", input: {}, name: "github__createOrUpdateFile", state: "proposed", type: "tool-call" },
          { id: "approval-1", name: "github__createOrUpdateFile", toolCallId: "call-1", type: "approval-request" },
        ],
        role: "assistant",
      },
      {
        id: "message-2",
        parts: [{ approved: true, id: "approval-1", type: "approval-decision" }],
        role: "assistant",
      },
    ]) as ModelMessage[]
    expect(await write.needsApproval({}, { messages, toolCallId: "call-2" })).toBe(true)

    const persistedContext = capabilityContext()
    persistedContext.invocation!.input.get = () => ({ context: { "vitehub.eve.approvedTools": ["github__createOrUpdateFile"] } })
    const persistedTools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(persistedContext)
    const persistedWrite = persistedTools.github__createOrUpdateFile as AgentToolDefinition & {
      needsApproval: (input: unknown, options: { messages: ModelMessage[], toolCallId: string }) => Promise<boolean>
    }
    expect(await persistedWrite.needsApproval({}, { messages: [], toolCallId: "call-3" })).toBe(false)
  })

  it("ignores dynamic event keys without handlers", async () => {
    const capability = await eveExtensionCapability(
      "test-extension",
      "test",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({
        dynamic: {
          events: {
            "session.ended": undefined,
            "session.started": () => undefined,
          },
          kind: "eve:dynamic",
        },
      }),
    )

    await expect((capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext()))
      .resolves.toEqual({})
  })

  it("starts dynamic tools once per session without retaining an invocation context", async () => {
    const execute = vi.fn(async (_input: unknown, context: { session: { turn: { id: string } } }) => context.session.turn.id)
    const started = vi.fn(() => ({ run: { execute } }))
    const capability = await eveExtensionCapability(
      "test-extension",
      "test",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({
        dynamic: {
          events: { "session.started": started },
          kind: "eve:dynamic",
        },
      }),
    )
    const first = capabilityContext()
    first.run = { runId: "run-1", threadId: "session-1" }
    const second = capabilityContext()
    second.run = { runId: "run-2", threadId: "session-1" }

    await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(first)
    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(second)

    expect(started).toHaveBeenCalledTimes(1)
    await expect(tools.test__run!.execute?.({}, { toolCallId: "call-1" } as never)).resolves.toBe("run-2")
  })
})
