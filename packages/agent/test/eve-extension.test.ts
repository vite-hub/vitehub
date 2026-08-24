import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"
import { parseAst } from "vite"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

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

    const persistedContext = capabilityContext()
    persistedContext.invocation!.input.get = () => ({ context: { "vitehub.eve.approvedTools": ["github__createOrUpdateFile"] } })
    const persistedTools = await (capability.tools as (context: AgentCapabilityContext) => Promise<Record<string, AgentToolDefinition>>)(persistedContext)
    const persistedWrite = persistedTools.github__createOrUpdateFile as AgentToolDefinition & {
      needsApproval: (input: unknown, options: { messages: ModelMessage[], toolCallId: string }) => Promise<boolean>
    }
    expect(await persistedWrite.needsApproval({}, { messages: [], toolCallId: "call-3" })).toBe(false)
  })

  it("preserves Eve tool output conversion for the model", async () => {
    const capability = await eveExtensionCapability(
      "example-extension",
      "example",
      async () => ({ default: () => ({ [Symbol.for("eve.mounted-extension")]: true }) }),
      async () => ({
        count: {
          execute: () => 1n,
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

  it("maps Eve session.started tools to each Agent Invocation", async () => {
    const started = vi.fn((_event: unknown, context: { session: { id: string } }) => ({
      run: {
        description: context.session.id,
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
    expect(firstTools.test__run!.description).toBe("run-1")
    expect(secondTools.test__run!.description).toBe("run-2")
    await expect(secondTools.test__run!.execute?.({}, { toolCallId: "call-1" } as never)).resolves.toBe("run-2")
  })
})
