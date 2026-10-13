import { fileURLToPath } from "node:url"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"
import { parseAst } from "vite"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { asSchema } from "ai"
import { defineDurableSchema } from "eve/tools"
import { z } from "zod"

import { toAiSdkModelMessages } from "../src/ai-sdk.ts"
import { eveExtensionCapability } from "../src/eve.ts"
import { createAgentChatApprovalCustody, withAgentChatApprovalGrant } from "../src/internal/chat-approvals.ts"
import { agentToolJsonSchema } from "../src/tool-schema.ts"
import { hubAgent, transformEveExtensionCapabilities } from "../src/vite.ts"

import type { AgentCapabilityContext, AgentToolDefinition } from "../src/types.ts"
import type { ModelMessage } from "ai"
import type { StateAdapter } from "chat"

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

function capabilityContext(): AgentCapabilityContext {
  const messages = () => []
  return {
    capabilities: {},
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

async function transformExtensionManifest(formatVersion: number, requires: Record<string, unknown>): Promise<string | undefined> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-eve-manifest-"))
  temporaryDirectories.push(root)
  const extensionRoot = join(root, "node_modules", "@test", "eve-extension")
  const extensionDist = join(extensionRoot, "dist", "extension")
  await mkdir(extensionDist, { recursive: true })
  await Promise.all([
    writeFile(join(extensionRoot, "package.json"), JSON.stringify({
      eve: { extension: { dist: "./dist/extension" } },
      name: "@test/eve-extension",
    })),
    writeFile(join(extensionDist, "_manifest.json"), JSON.stringify({ formatVersion, kind: "eve-extension", requires })),
    writeFile(join(extensionRoot, "index.js"), "export default () => ({})"),
  ])
  const plugin = hubAgent()
  await (plugin.configResolved as (config: unknown) => Promise<void>)({
    command: "serve",
    createResolver: () => async (specifier: string) => specifier === "@test/eve-extension" ? join(extensionRoot, "index.js") : undefined,
    plugins: [],
    root,
  })
  return (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
    { parse: parseAst },
    [
      `import { defineAgent } from "@vite-hub/agent"`,
      `import extension from "@test/eve-extension"`,
      `export default defineAgent({ capabilities: [extension()] })`,
    ].join("\n"),
    join(root, "server", "agents", "reviewer.ts"),
  )
}

describe("Eve extension capabilities", () => {
  it.each([
    [1, 5, 8],
    [2, 20, 20],
    [2, 54, 52],
  ])("accepts format %i tool@%i and dynamicTool@%i manifests", async (formatVersion, tool, dynamicTool) => {
    await expect(transformExtensionManifest(formatVersion, { config: 1, dynamicTool, extension: 1, tool }))
      .resolves.toContain(`await __vitehubEveExtensionCapability("@test/eve-extension", "pkg-_atest_seve-extension"`)
  })

  it.each([
    [1, "tool", 20],
    [1, "dynamicTool", 20],
    [2, "tool", 21],
    [2, "dynamicTool", 21],
    [2, "tool", 76],
    [2, "dynamicTool", 72],
    [2, "unknown", 1],
    [2, "toString", 1],
    [2, "__proto__", 1],
  ] as const)("rejects format %i %s@%i manifests", async (formatVersion, contract, version) => {
    const requires = formatVersion === 1
      ? { config: 1, dynamicTool: 8, extension: 1, tool: 5 }
      : { config: 1, dynamicTool: 20, extension: 1, tool: 20 }
    await expect(transformExtensionManifest(formatVersion, { ...requires, [contract]: version }))
      .rejects.toThrow(`requires unsupported ${contract}@${version}`)
  })

  it("accepts the current Eve compatibility manifest and publishes Eve as an optional peer", async () => {
    const packageJson = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    expect(packageJson.devDependencies?.eve).toBe("0.72.1")
    expect(packageJson.peerDependencies?.eve).toBe("0.46.1 || 0.72.1")
    expect(packageJson.peerDependenciesMeta?.eve).toEqual({ optional: true })

    const extensionEntry = fileURLToPath(import.meta.resolve("@github-tools/eve-extension"))
    const extensionRoot = dirname(dirname(extensionEntry))
    const extensionPackage = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8")) as {
      eve?: { extension?: { dist?: string, source?: string } }
    }
    expect(extensionPackage.eve?.extension).toMatchObject({ dist: "./dist/extension", source: "./extension" })

    const manifest = JSON.parse(await readFile(join(extensionRoot, "dist", "extension", "_manifest.json"), "utf8")) as {
      formatVersion?: number
      kind?: string
      requires?: Record<string, number>
    }
    expect(manifest).toMatchObject({
      formatVersion: 2,
      kind: "eve-extension",
      requires: { config: 1, dynamicTool: 52, extension: 1, tool: 54 },
    })
  })

  it.each([
    { requires: { dynamicTool: 21 }, error: "unsupported dynamicTool@21" },
    { requires: { tool: 53 }, error: "unsupported tool@53" },
    { requires: { tool: 55 }, error: "unsupported tool@55" },
    { requires: { unknownContract: 1 }, error: "unsupported unknownContract@1" },
    { requires: { tool: "20" }, error: "unsupported tool@20" },
    { requires: { tool: 20.5 }, error: "unsupported tool@20.5" },
  ])("rejects unsupported Eve contracts: $error", async ({ requires, error }) => {
    await expect(transformExtensionManifest(2, requires)).rejects.toThrow(error)
  })

  it("uses the injective generated namespace as the Eve configuration scope", async () => {
    const scopes: string[] = []
    const loadExtension = async () => ({
      default: () => {
        scopes.push((globalThis as Record<symbol, string>)[Symbol.for("eve.ext-config-scope")])
        return { [Symbol.for("eve.mounted-extension")]: true }
      },
    })

    await eveExtensionCapability("@one/foo-extension", "pkg-_aone_sfoo-extension", loadExtension, async () => ({}))
    await eveExtensionCapability("one-foo-extension", "pkg-one-foo-extension", loadExtension, async () => ({}))

    expect(scopes).toEqual(["pkg-_aone_sfoo-extension", "pkg-one-foo-extension"])
  })

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
    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
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
        moduleGraph: { idToModuleMap: new Map(), getModuleById: () => undefined },
      },
    })
    await expect((plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "other.ts"),
    )).resolves.toContain(`from "@vite-hub/agent/eve"`)

    const watcher = new EventEmitter()
    ;(plugin.config as unknown as (config: { agent: boolean }) => void)({ agent: false })
    await (plugin.configureServer as (server: unknown) => Promise<void>)({
      config: { root, logger: { error: vi.fn() } },
      middlewares: { use: () => {} },
      moduleGraph: { idToModuleMap: new Map(), invalidateModule: vi.fn() },
      watcher,
    })
    ;(plugin.config as unknown as (config: { agent: Record<string, never> }) => void)({ agent: {} })
    const otherId = join(root, "server", "agents", "other.ts")
    watcher.emit("unlink", otherId)
    try {
      await expect((plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
        { parse: parseAst },
        source,
        id,
      )).resolves.toContain(`from "@vite-hub/agent/eve"`)
    }
    finally {
      await (plugin.closeBundle as { handler: () => Promise<void> }).handler()
    }
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
    expect(transformed).not.toContain(`import github from`)
  })

  it("detects TypeScript-wrapped Eve extension calls", async () => {
    const parseWithWrappers = (code: string) => {
      const ast = parseAst(code) as unknown as Record<string, unknown>
      const visit = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return false
        const node = value as Record<string, unknown>
        if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
          const index = node.elements.findIndex(element => (element as { callee?: { name?: unknown } })?.callee?.name === "github")
          if (index >= 0) {
            const call = node.elements[index] as Record<string, unknown>
            const callee = call.callee as { end: number, start: number }
            const wrappedCall = {
              ...call,
              callee: { end: callee.end, expression: callee, start: callee.start, type: "TSAsExpression" },
            }
            node.elements[index] = { end: call.end, expression: wrappedCall, start: call.start, type: "TSAsExpression" }
            return true
          }
        }
        return Object.values(node).some(child => Array.isArray(child) ? child.some(visit) : visit(child))
      }
      visit(ast)
      return ast
    }
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        export default defineAgent({ capabilities: [github()] })
      `,
      parseWithWrappers,
      async () => true,
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
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

  it("allows non-Eve Capability factories in composable Agent Definitions", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import plugin from "ordinary-capability"
        export function createAgent() {
          return defineAgent({ capabilities: [plugin()] })
        }
      `,
      parseAst,
      async () => false,
    )

    expect(transformed).toBeUndefined()
  })

  it("does not lower calls to a shadowed imported defineAgent binding", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        {
          const defineAgent = options => options
          defineAgent({ capabilities: [github()] })
        }
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
  })

  it("does not lower calls to declaration- or destructuring-shadowed bindings", async () => {
    for (const shadow of [
      `function defineAgent(options) { return options }`,
      `const { defineAgent } = local`,
    ]) {
      const transformed = await transformEveExtensionCapabilities(
        `
          import { defineAgent } from "@vite-hub/agent"
          import github from "@github-tools/eve-extension"
          {
            ${shadow}
            defineAgent({ capabilities: [github()] })
          }
        `,
        parseAst,
        async () => true,
      )

      expect(transformed).toBeUndefined()
    }
  })

  it("hoists var shadows to their containing function", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        function createAgent(localFactory) {
          if (localFactory) var defineAgent = localFactory
          return defineAgent({ capabilities: [github()] })
        }
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
  })

  it("rejects separate runtime imports from a mounted extension", async () => {
    await expect(transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        import { defineConfig } from "@github-tools/eve-extension"
        export default defineAgent({ capabilities: [github(defineConfig({}))] })
      `,
      parseAst,
      async () => true,
    )).rejects.toThrow("cannot be imported separately as a runtime value")
  })

  it("injects the configured Agent runtime import", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "vite-hub/agent"
        import github from "@github-tools/eve-extension"
        export default defineAgent({ capabilities: [github()] })
      `,
      parseAst,
      async () => true,
      "vite-hub/_internal/agent",
    )

    expect(transformed).toContain(`from "vite-hub/_internal/agent/eve"`)
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
  })

  it("resolves factored Agent Definition options by lexical binding", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        const options = { capabilities: [github()] }
        {
          const options = { capabilities: [] }
          defineAgent(options)
        }
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
  })

  it("does not lower capabilities that a later unresolved spread can override", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        export default defineAgent({ capabilities: [github()], ...runtimeOptions })
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
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

    expect(transformed).toContain(`"@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
    expect(transformed).not.toContain(`"$github"`)
  })

  it("resolves Vite aliases to the Eve package identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-eve-extension-"))
    temporaryDirectories.push(root)
    const plugin = hubAgent()
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      command: "serve",
      createResolver: () => async (specifier: string) => fileURLToPath(import.meta.resolve(
        specifier === "github-tools" ? "@github-tools/eve-extension" : specifier,
      )),
      plugins: [],
      root,
    })
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      [
        `import { defineAgent } from "@vite-hub/agent"`,
        `import github from "github-tools"`,
        `export default defineAgent({ capabilities: [github()] })`,
      ].join("\n"),
      join(root, "server", "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`"@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
    expect(transformed).toContain(`() => import("github-tools")`)
  })

  it("rejects canonical eager imports beside an aliased mount", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-eve-extension-"))
    temporaryDirectories.push(root)
    const plugin = hubAgent()
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      command: "serve",
      createResolver: () => async (specifier: string) => fileURLToPath(import.meta.resolve(
        specifier === "github-tools" ? "@github-tools/eve-extension" : specifier,
      )),
      plugins: [],
      root,
    })

    await expect((plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      [
        `import { defineAgent } from "@vite-hub/agent"`,
        `import github from "github-tools"`,
        `import { defineConfig } from "@github-tools/eve-extension"`,
        `export default defineAgent({ capabilities: [github(defineConfig({}))] })`,
      ].join("\n"),
      join(root, "server", "agents", "reviewer.ts"),
    )).rejects.toThrow("cannot be imported separately as a runtime value")
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

    expect(transformed).toContain('EveExtensionCapability("@one/foo-extension", "pkg-_aone_sfoo-extension"')
    expect(transformed).toContain('EveExtensionCapability("@two/foo-extension", "pkg-_atwo_sfoo-extension"')
  })

  it("disambiguates scoped and unscoped package identities that share a readable namespace", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import scoped from "@one/foo-extension"
        import unscoped from "one-foo-extension"
        export default defineAgent({ capabilities: [scoped(), unscoped()] })
      `,
      parseAst,
      async specifier => specifier.endsWith("foo-extension"),
    )

    expect(transformed).toContain('EveExtensionCapability("@one/foo-extension", "pkg-_aone_sfoo-extension"')
    expect(transformed).toContain('EveExtensionCapability("one-foo-extension", "pkg-one-foo-extension"')
  })

  it("rejects an Eve factory imported with named runtime values", async () => {
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
    await expect((plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "server", "agents", "reviewer.ts"),
    )).rejects.toThrow("cannot share its import with named runtime values")
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
  })

  it("detects Eve extensions in a separately exported static capabilities array", async () => {
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
      `const capabilities = [github()]`,
      `export { capabilities }`,
    ].join("\n")
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      source,
      join(root, "capabilities.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
  })

  it("does not infer Agent Definition ownership from an exported name", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import github from "@github-tools/eve-extension"
        export const reviewCapabilities = [github()]
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
  })

  it("does not lower unrelated exported Eve arrays", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import github from "@github-tools/eve-extension"
        export const extensions = [github()]
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
  })

  it("lowers Agent Definitions in configured server directories outside the root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vitehub-eve-extension-"))
    temporaryDirectories.push(workspace)
    const root = join(workspace, "app")
    const serverDir = join(workspace, "server")
    const plugin = hubAgent()
    ;(plugin.config as unknown as (config: Record<PropertyKey, unknown>) => void)({ [VITEHUB_SERVER_DIRS]: [serverDir] })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      command: "serve",
      createResolver: () => async (specifier: string) => fileURLToPath(import.meta.resolve(specifier)),
      plugins: [],
      root,
    })
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        export default defineAgent({ capabilities: [github()] })
      `,
      join(serverDir, "agents", "reviewer.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
  })

  it("lowers Capability modules in configured server directories outside the root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vitehub-eve-extension-"))
    temporaryDirectories.push(workspace)
    const root = join(workspace, "app")
    const serverDir = join(workspace, "server")
    const plugin = hubAgent()
    ;(plugin.config as unknown as (config: Record<PropertyKey, unknown>) => void)({ [VITEHUB_SERVER_DIRS]: [serverDir] })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      command: "serve",
      createResolver: () => async (specifier: string) => fileURLToPath(import.meta.resolve(specifier)),
      plugins: [],
      root,
    })
    const transformed = await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
      { parse: parseAst },
      `
        import github from "@github-tools/eve-extension"
        export const capabilities = [github()]
      `,
      join(serverDir, "capabilities.ts"),
    )

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
  })

  it("removes an Eve import when only a shadowed binding remains", async () => {
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
    expect(transformed).not.toContain(`import github from "@github-tools/eve-extension"`)
  })

  it("does not lower a lexically shadowed extension factory", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        {
          const github = () => ({ id: "local" })
          defineAgent({ capabilities: [github()] })
        }
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
  })

  it.each([
    `defineAgent(settings("installation-token"))`,
    `defineAgent({ ...settings("installation-token"), workspace: {} })`,
    `defineAgent(options)`,
  ])("rejects an Eve extension hidden behind dynamic Agent Definition options: %s", async definition => {
    await expect(transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        const settings = token => ({ capabilities: [github({ token })] })
        const options = settings("installation-token")
        export default ${definition}
      `,
      parseAst,
      async specifier => specifier === "@github-tools/eve-extension",
    )).rejects.toThrow("must be mounted in a top-level static capabilities array")
  })

  it("keeps shadowed dynamic option factories unrelated to the top-level factory", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        const settings = token => ({ capabilities: [github({ token })] })
        {
          const settings = () => ({ metadata: { safe: true } })
          defineAgent(settings())
        }
      `,
      parseAst,
      async specifier => specifier === "@github-tools/eve-extension",
    )

    expect(transformed).toBeUndefined()
  })

  it("keeps static block bindings scoped to the block", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        class AgentFactory {
          static {
            const github = () => ({ id: "local" })
            defineAgent({ capabilities: [github()] })
          }
        }
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
  })

  it("rejects extension mounts inside static blocks", async () => {
    await expect(transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        class AgentFactory {
          static {
            defineAgent({ capabilities: [github()] })
          }
        }
      `,
      parseAst,
      async specifier => specifier === "@github-tools/eve-extension",
    )).rejects.toThrow("must be mounted in a top-level static capabilities array")
  })

  it.each(["", "static "])("rejects extension mounts inside %sclass fields", async fieldPrefix => {
    await expect(transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        class AgentFactory {
          ${fieldPrefix}agent = defineAgent({ capabilities: [github()] })
        }
      `,
      parseAst,
      async specifier => specifier === "@github-tools/eve-extension",
    )).rejects.toThrow("must be mounted in a top-level static capabilities array")
  })

  it("does not lower a catch-parameter-shadowed extension factory", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        try {} catch (github) {
          defineAgent({ capabilities: [github()] })
        }
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toBeUndefined()
  })

  it("keeps loop bindings scoped to the loop", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        for (const github of []) github()
        export default defineAgent({ capabilities: [github()] })
      `,
      parseAst,
      async () => true,
    )

    expect(transformed).toContain("__vitehubEveExtensionCapability(")
  })

  it("rejects surviving extension factory references", async () => {
    await expect(transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        const integration = github
        export default defineAgent({ capabilities: [github()], metadata: { integration } })
      `,
      parseAst,
      async () => true,
    )).rejects.toThrow("cannot be referenced outside its static Capability mount")
  })

  it("ignores the imported side of an aliased non-extension import", async () => {
    const transformed = await transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        import { github as githubChannel } from "@vite-hub/agent/channels"
        export default defineAgent({
          capabilities: [github()],
          channels: { github: githubChannel({ activity: true }) },
        })
      `,
      parseAst,
      async source => source === "@github-tools/eve-extension",
    )

    expect(transformed).toContain("__vitehubEveExtensionCapability(")
    expect(transformed).toContain("githubChannel({ activity: true })")
  })

  it("rejects extension factory references inside mount config", async () => {
    await expect(transformEveExtensionCapabilities(
      `
        import { defineAgent } from "@vite-hub/agent"
        import github from "@github-tools/eve-extension"
        export default defineAgent({ capabilities: [github({ decorate: github })] })
      `,
      parseAst,
      async () => true,
    )).rejects.toThrow("cannot be referenced outside its static Capability mount")
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

    expect(transformed).toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
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
    )).resolves.toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)

    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: join(root, "server", "agents", "inline.ts"),
      server: { config: { root }, moduleGraph: { idToModuleMap: new Map(), getModuleById: () => undefined } },
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
    )).resolves.toContain(`await __vitehubEveExtensionCapability("@github-tools/eve-extension", "pkg-_agithub-tools_seve-extension"`)
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

    const writeTool = async (context: AgentCapabilityContext) => (await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(context))
      .github__createOrUpdateFile as AgentToolDefinition & {
      needsApproval: (input: unknown, options: { messages: ModelMessage[], toolCallId: string }) => Promise<boolean>
    }
    const sessionContext = capabilityContext()
    sessionContext.invocation!.input.get = () => ({ context: { "chat.sessionId": "session-1" } })

    const forgedContext = capabilityContext()
    forgedContext.invocation!.input.get = () => ({
      context: { "chat.sessionId": "session-1", "vitehub.eve.approvedTools": ["github__createOrUpdateFile"] },
    })
    expect(await (await writeTool(forgedContext)).needsApproval({}, { messages: [], toolCallId: "call-3" })).toBe(true)

    // SAFETY: Authorizing a request without approval parts reads only the session's approved tools.
    const state = { get: async () => ["github__createOrUpdateFile"] } as unknown as StateAdapter
    const { grant } = await createAgentChatApprovalCustody({ authenticated: true, invokerId: "test", sessionId: "session-1", state }).authorize([])
    expect(await (await writeTool(withAgentChatApprovalGrant(sessionContext, grant))).needsApproval({}, { messages: [], toolCallId: "call-4" })).toBe(false)
    expect(await (await writeTool(withAgentChatApprovalGrant(capabilityContext(), grant))).needsApproval({}, { messages: [], toolCallId: "call-5" })).toBe(true)
  })

  it("preserves GitHub durable schema validation, output schemas, and execution", async () => {
    const fetch = vi.fn(async () => Response.json({
      content: Buffer.from(" ViteHub ").toString("base64"),
      encoding: "base64",
      path: "README.md",
      sha: "file-sha",
      size: 9,
      type: "file",
    }))
    vi.stubGlobal("fetch", fetch)
    const capability = await eveExtensionCapability(
      "@github-tools/eve-extension",
      "github",
      async () => await import("@github-tools/eve-extension") as unknown as Record<string, unknown>,
      async () => await import("@github-tools/eve-extension/tools") as unknown as Record<string, unknown>,
      {
        include: ["getFileContent"],
        overrides: {
          getFileContent: {
            outputSchema: z.object({ content: z.string().trim(), type: z.literal("file") }),
          },
        },
        token: "test-token",
      },
    )
    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext())
    const read = tools.github__getFileContent as AgentToolDefinition & {
      toModelOutput: (options: { output: unknown }) => Promise<unknown>
    }
    const liveInputSchema = read.inputSchema
    const outputSchema = read.outputSchema?.["~standard"]
    if (!liveInputSchema?.["~standard"] || !outputSchema) throw new Error("Expected live GitHub durable schemas")
    const inputSchema = liveInputSchema["~standard"]
    const modelInputSchema = asSchema(liveInputSchema)

    expect(inputSchema.vendor).toBe("eve")
    expect(outputSchema.vendor).toBe("eve")
    expect(agentToolJsonSchema(read.inputSchema, "input")).toMatchObject({
      properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } },
      required: ["owner", "repo", "path"],
      type: "object",
    })
    expect(agentToolJsonSchema(read.outputSchema, "output")).toMatchObject({
      properties: { content: { type: "string" }, type: { const: "file" } },
      required: ["content", "type"],
      type: "object",
    })
    const input = { owner: "vite-hub", repo: "vitehub", path: "README.md" }
    expect(await inputSchema.validate(input)).toEqual({ value: input })
    expect((await inputSchema.validate({ ...input, path: 42 })).issues?.length).toBeGreaterThan(0)
    expect(await modelInputSchema.jsonSchema).toMatchObject({
      additionalProperties: false,
      properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } },
      required: ["owner", "repo", "path"],
      type: "object",
    })
    expect(await modelInputSchema.validate?.(input)).toEqual({ success: true, value: input })
    expect(await modelInputSchema.validate?.({ ...input, path: 42 })).toMatchObject({ success: false })

    const output = await read.execute?.(input, { toolCallId: "github-read-1" })
    expect(output).toMatchObject({ content: " ViteHub ", path: "README.md", totalLines: 1, type: "file" })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/vite-hub/vitehub/contents/README.md",
      expect.objectContaining({ method: "GET" }),
    )
    expect(await outputSchema.validate(output)).toEqual({ value: { content: "ViteHub", type: "file" } })
    expect(await read.toModelOutput({ output })).toEqual({ type: "json", value: output })
  })

  it("preserves durable schema conversion errors", async () => {
    const failure = new Error("Cannot emit the tool schema")
    const schema = defineDurableSchema({
      closure: {},
      schema: () => ({
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            input: () => { throw failure },
            output: () => { throw failure },
          },
        },
      }),
    })
    const capability = await eveExtensionCapability(
      "schema-extension",
      "schema",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({ inspect: { inputSchema: schema, outputSchema: schema, execute: () => "ok" } }),
    )
    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext())
    const inspect = tools.schema__inspect!

    expect(inspect.inputSchema).toBe(schema)
    expect(inspect.outputSchema).toBe(schema)
    expect(() => agentToolJsonSchema(inspect.inputSchema, "input")).toThrow(failure)
    expect(() => agentToolJsonSchema(inspect.outputSchema, "output")).toThrow(failure)
  })

  it("preserves the Eve execute receiver and output conversion for the model", async () => {
    const capability = await eveExtensionCapability(
      "example-extension",
      "example",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({
        count: {
          value: 1n,
          execute(this: { value: bigint }) { return this.value },
          toModelOutput: (output: unknown) => ({ value: String(output) }),
        },
      }),
    )
    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext())
    const count = tools.example__count as AgentToolDefinition & {
      execute: (input: unknown) => Promise<unknown>
      toModelOutput: (options: { output: unknown }) => Promise<unknown>
    }

    expect(await count.execute({})).toBe(1n)
    expect(await count.toModelOutput({ output: 1n })).toEqual({ value: "1" })
  })

  it("uses the request policy from Eve approval configurations", async () => {
    const request = vi.fn(() => ({ type: "user-approval" as const }))
    const capability = await eveExtensionCapability(
      "approval-extension",
      "approval",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({
        write: {
          description: "Write a value",
          approval: { request },
          execute: async () => "ok",
        },
      }),
    )
    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext())
    const write = tools.approval__write as AgentToolDefinition & {
      needsApproval: (input: unknown, options: { toolCallId: string }) => Promise<boolean>
    }

    await expect(write.needsApproval({}, { toolCallId: "call-approval" })).resolves.toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })

  it("accepts an Eve tool without an approval policy", async () => {
    const capability = await eveExtensionCapability(
      "approval-extension",
      "approval",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({ read: { approval: null, execute: () => "ok" } }),
    )
    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext())

    await expect(tools.approval__read!.execute?.({})).resolves.toBe("ok")
    expect(tools.approval__read).not.toHaveProperty("needsApproval")
  })

  it("reports unsupported skill access in older Eve execution and approval contexts", async () => {
    const capability = await eveExtensionCapability(
      "skill-extension",
      "skill",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({
        execute: {
          execute: (_input: unknown, context: { getSkill: (id: string) => unknown }) => context.getSkill("test-skill"),
        },
        approve: {
          approval: (context: { getSkill: (id: string) => unknown }) => context.getSkill("test-skill"),
          execute: () => "ok",
        },
      }),
    )
    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext())
    const approve = tools.skill__approve as AgentToolDefinition & { needsApproval: (input: unknown) => Promise<boolean> }

    await expect(tools.skill__execute!.execute?.({})).rejects.toMatchObject({
      code: "AGENT_R0415",
      message: expect.stringContaining("ctx.getSkill()"),
    })
    await expect(approve.needsApproval({})).rejects.toMatchObject({
      code: "AGENT_R0415",
      message: expect.stringContaining("approval ctx.getSkill()"),
    })
  })

  it("rejects Eve approval response authorizers", async () => {
    const capability = await eveExtensionCapability(
      "approval-extension",
      "approval",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({
        write: {
          description: "Write a value",
          approval: {
            request: () => "user-approval",
            response: () => ({ status: "allowed" }),
          },
          execute: async () => "ok",
        },
      }),
    )

    await expect((capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext()))
      .rejects.toThrow("approval.response")
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

  it("supplies a non-aborted signal during static dynamic-tool inspection", async () => {
    const started = vi.fn((_event: unknown, context: { abortSignal: AbortSignal }) => {
      context.abortSignal.throwIfAborted()
      return { run: { execute: async () => "ok" } }
    })
    const capability = await eveExtensionCapability(
      "test-extension",
      "test",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({ dynamic: { events: { "session.started": started }, kind: "eve:dynamic" } }),
    )
    const context = capabilityContext()
    delete context.invocation

    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(context)

    expect(started).toHaveBeenCalledOnce()
    expect(started.mock.calls[0]![1].abortSignal.aborted).toBe(false)
    expect(tools.test__run).toBeDefined()
  })

  it("maps Eve session.started tools to each Agent Invocation", async () => {
    const started = vi.fn((event: { data: Record<string, unknown> }, context: { session: { id: string } }) => ({
      run: {
        description: context.session.id,
        metadata: { eventData: event.data },
        execute: async (_input: unknown, toolContext: { session: { turn: { id: string } } }) => toolContext.session.turn.id,
      },
    }))
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

    const firstTools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(first)
    const secondTools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(second)

    expect(started).toHaveBeenCalledTimes(2)
    expect(firstTools.test__run!.description).toBe("session-1")
    expect(secondTools.test__run!.description).toBe("session-1")
    expect(firstTools.test__run!.metadata).toEqual({ eventData: {} })
    expect(secondTools.test__run!.metadata).toEqual({ eventData: {} })
    await expect(secondTools.test__run!.execute?.({}, { toolCallId: "call-1" } as never)).resolves.toBe("run-2")
  })

  it("rejects unavailable authoritative step index when a step.started handler reads it", async () => {
    const handler = vi.fn((input: { data: { stepIndex: number } }) => ({ run: { description: String(input.data.stepIndex), execute: () => "ok" } }));
    const capability = await eveExtensionCapability(
      "test-extension", "test",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({ dynamic: { events: { "step.started": handler }, kind: "eve:dynamic" } }),
    );
    await expect((capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext()))
      .rejects.toMatchObject({ code: "AGENT_R0415", message: expect.stringContaining("stepIndex") });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(["turn.started", "step.started"])("rejects unavailable authoritative data when %s handlers read it", async event => {
    const handler = vi.fn((input: { data: { sequence: number, modelId: string } }) => ({ run: { description: String(event === "step.started" ? input.data.modelId : input.data.sequence), execute: () => "ok" } }))
    const capability = await eveExtensionCapability(
      "test-extension", "test",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({ dynamic: { events: { [event]: handler }, kind: "eve:dynamic" } }),
    )
    await expect((capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext()))
      .rejects.toMatchObject({ code: "AGENT_R0415", message: expect.stringContaining(event === "step.started" ? "modelId" : "sequence") })
    expect(handler).toHaveBeenCalledOnce()
  })

  it.each(["execute", "approval"])("rejects unavailable authoritative turn sequence in Eve %s contexts", async mode => {
    const readSequence = (context: { session: { turn: { sequence: number } } }) => context.session.turn.sequence
    const capability = await eveExtensionCapability(
      "test-extension", "test",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({ run: {
        execute: (_input: unknown, context: { session: { turn: { sequence: number } } }) => mode === "execute" ? readSequence(context) : "ok",
        approval: (context: { session: { turn: { sequence: number } } }) => { readSequence(context); return "not-applicable" },
      } }),
    )
    for (const runId of ["turn-1", "turn-2"]) {
      const context = capabilityContext()
      context.run = { runId, threadId: "session-1" }
      const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(context)
      const tool = tools.test__run as AgentToolDefinition & { needsApproval: (input: unknown) => Promise<boolean> }
      await expect(mode === "execute" ? tool.execute!({}) : tool.needsApproval({}))
        .rejects.toMatchObject({ code: "AGENT_R0415", message: expect.stringContaining("session.turn.sequence") })
    }
  })

  it("preserves Eve execution context from preparation-time dynamic tools", async () => {
    const abortSignal = new AbortController().signal
    const started = vi.fn((event: { data: Record<string, unknown>, type: string }, context: { messages: readonly ModelMessage[], session: { id: string, turn: { id: string } } }) => ({
      turn: {
        description: `${event.type}:${context.session.id}`,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        execute: async (_input: unknown, toolContext: { abortSignal: AbortSignal, messages: readonly ModelMessage[], session: { id: string, turn: { id: string } } }) => ({
          hasAbortSignal: toolContext.abortSignal === abortSignal,
          messageCount: toolContext.messages.length,
          session: toolContext.session.id,
          turn: toolContext.session.turn.id,
        }),
        toModelOutput: (output: unknown) => ({
          type: "content",
          value: [{ type: "text", text: JSON.stringify(output) }],
        }),
      },
    }))
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
    const context = capabilityContext()
    context.run = { runId: "turn-2", threadId: "session-1" }
    context.abortSignal = abortSignal
    context.invocation!.input.messages = () => [
      { id: "message-1", parts: [{ text: "Previous", type: "text" }], role: "user" },
      { id: "message-2", parts: [{ text: "Current", type: "text" }], role: "user" },
    ] as never

    const tools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(context)
    const tool = tools.test__turn as AgentToolDefinition & {
      execute: (input: unknown, options: { messages: ModelMessage[], toolCallId: string }) => Promise<unknown>
      outputSchema?: unknown
      toModelOutput: (options: { output: unknown }) => Promise<unknown>
    }

    expect(started).toHaveBeenCalledWith({ data: {}, type: "session.started" }, expect.objectContaining({
      abortSignal,
      model: null,
      session: expect.objectContaining({ id: "session-1" }),
    }))
    const [event, resolvedContext] = started.mock.calls[0]!
    expect(event.data).toEqual({})
    expect(resolvedContext.session.turn.id).toBe("turn-2")
    expect(tool.description).toBe("session.started:session-1")
    expect(tool.outputSchema).toEqual({ type: "object" })
    await expect(tool.execute({}, { messages: [{ role: "user", content: "Hello" }], toolCallId: "call-1" })).resolves.toEqual({
      hasAbortSignal: true,
      messageCount: 1,
      session: "session-1",
      turn: "turn-2",
    })
    await expect(tool.toModelOutput({ output: { ok: true } })).resolves.toEqual({
      type: "content",
      value: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    })
  })

  it("rejects dynamic tools with several active lifecycle handlers", async () => {
    const capability = await eveExtensionCapability(
      "test-extension",
      "test",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({
        dynamic: {
          events: {
            "session.started": () => undefined,
            "step.started": () => undefined,
          },
          kind: "eve:dynamic",
        },
      }),
    )

    await expect((capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(capabilityContext()))
      .rejects.toThrow("uses unsupported events: session.started, step.started")
  })
})
