import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { parseAst } from "vite"

import { resolvesWorkerConditions, usesProviderAgentDriver } from "../src/internal/provider-driver-usage.ts"
import { createProviderAgentAdapter, inspectAgentProvider } from "../src/runtime/provider-agent-worker.ts"
import { hubAgent } from "../src/vite.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function transformServerModule(source: string, conditions: string[]) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-provider-worker-"))
  temporaryDirectories.push(root)
  const plugin = hubAgent()
  // SAFETY: The test supplies the resolved config fields that configResolved reads.
  await (plugin.configResolved as (config: unknown) => Promise<void>)({ command: "build", plugins: [], root })
  // SAFETY: hubAgent defines transform as a callable Vite hook; the context supplies the fields it reads.
  return await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
    { environment: { config: { resolve: { conditions } } }, parse: parseAst },
    source,
    join(root, "server", "agents", "support.ts"),
  )
}

describe("provider Agent Drivers in Worker builds", () => {
  it.each([
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: "codex" })`,
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: 'claude-code' })`,
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { kind: "codex", permissions: "allow-edits" } })`,
    `import { codexDriver, defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: codexDriver({ model: "gpt-5" }) })`,
    `import { claudeCodeDriver, defineAgent } from "@vite-hub/agent"; export default defineAgent({ capabilities: [title({ driver: claudeCodeDriver() })], driver: { model: "openai/gpt-5" } })`,
    `import { codexDriver as makeDriver, defineAgent as define } from "@vite-hub/agent"; export default define({ driver: makeDriver() })`,
    `import * as agent from "@vite-hub/agent"; export default agent.defineAgent({ driver: agent.codexDriver() })`,
    `import workspace from "vite-hub/agent/presets/workspace"`,
    `import { babysitter } from "@vite-hub/agent/presets/babysitter"`,
  ])("finds a provider Driver in %s", (source) => {
    expect(usesProviderAgentDriver(source)).toBe(true)
  })

  it.each([
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { run: () => "ok" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const instructions = 'driver: "codex"'; export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const url = "https://example.com//driver: \\\"codex\\\""; export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const value = { kind: "codex" }; export default defineAgent({ driver: { run: () => "codex" } })`,
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ options: { driver: "codex" }, driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ settings: { nested: { driver: { kind: "codex" } } }, driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ capabilities: [customCapability({ driver: "codex" })], driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const title = ({ driver }: { driver: string }) => customCapability({ driver }); export default defineAgent({ capabilities: [title({ driver: "codex" })], driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const code = /codexDriver\\(\\)/; export default defineAgent({ driver: { run: () => "codex" } })`,
    `import type { codexDriver } from "@vite-hub/agent"; import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const normalize = (defineAgent: (options: unknown) => unknown) => defineAgent({ driver: "codex" }); export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import { codexDriver, defineAgent } from "@vite-hub/agent"; { const codexDriver = () => ({ model: "openai/gpt-5" }); codexDriver() } export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import { type workspace } from "vite-hub/agent/presets/workspace"`,
    `import { type workspace } from "@vite-hub/agent/presets/workspace"`,
    `import { codexDriver, defineAgent } from "@vite-hub/agent"; const normalize = (codexDriver: () => unknown) => codexDriver(); export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import workspace from "@acme/presets/workspace"`,
    `import { workspace } from "@acme/presets/babysitter"`,
    `import type { workspace } from "vite-hub/agent/presets/workspace"`,
  ])("ignores model and run Drivers in %s", (source) => {
    expect(usesProviderAgentDriver(source)).toBe(false)
  })

  it("detects value imports in mixed preset specifiers", () => {
    expect(usesProviderAgentDriver(`import { type WorkspaceOptions, workspace } from "@vite-hub/agent/presets/workspace"`)).toBe(true)
  })

  it.each([
    ["codexDriver", `codexDriver()`],
    ["makeDriver", `makeDriver()`],
    ["defineAgent", `defineAgent({ driver: "codex" })`],
    ["agent", `agent.codexDriver()`],
    ["title", `defineAgent({ capabilities: [title({ driver: "codex" })] })`],
    ["progressSummary", `defineAgent({ capabilities: [progressSummary({ driver: "codex" })] })`],
    ["capabilities", `defineAgent({ capabilities: [capabilities.title({ driver: "codex" })] })`],
  ])("respects the named function expression binding %s", async (binding, call) => {
    const imports = `import { codexDriver, codexDriver as makeDriver, defineAgent } from "@vite-hub/agent"; import * as agent from "@vite-hub/agent"; import { title, progressSummary } from "@vite-hub/agent/capabilities"; import * as capabilities from "@vite-hub/agent/capabilities";`
    const source = `${imports} const walk = function ${binding}() { return ${call} }`
    expect(usesProviderAgentDriver(source)).toBe(false)
    await expect(transformServerModule(source, ["workerd", "worker"])).resolves.toBeUndefined()
    expect(usesProviderAgentDriver(`${source}; ${call}`)).toBe(true)
  })

  it.each([
    ["codexDriver", `codexDriver()`],
    ["defineAgent", `defineAgent({ driver: "codex" })`],
    ["agent", `agent.codexDriver()`],
    ["capabilities", `defineAgent({ capabilities: [capabilities.title({ driver: "codex" })] })`],
  ])("respects hoisted var declarations for %s", async (binding, call) => {
    const imports = `import { codexDriver, defineAgent } from "@vite-hub/agent"; import * as agent from "@vite-hub/agent"; import * as capabilities from "@vite-hub/agent/capabilities";`
    const body = `switch (${call}) { case 0: var ${binding}; } return ${call}`
    const source = `${imports} function make() { ${body} }`
    expect(usesProviderAgentDriver(source)).toBe(false)
    await expect(transformServerModule(source, ["workerd", "worker"])).resolves.toBeUndefined()
    expect(usesProviderAgentDriver(`${source}; ${call}`)).toBe(true)
    expect(usesProviderAgentDriver(`${imports} function make() { ${call}; { var ${binding}; } }`)).toBe(false)
    expect(usesProviderAgentDriver(`${imports} function make() { ${call}; for (var ${binding} of []) {} }`)).toBe(false)
    expect(usesProviderAgentDriver(`${imports} function make() { ${call}; function nested() { var ${binding}; } }`)).toBe(true)
    expect(usesProviderAgentDriver(`${imports} function make() { ${call}; const nested = () => { var ${binding}; } }`)).toBe(true)
    expect(usesProviderAgentDriver(`${imports} function make(value = ${call}) { var ${binding}; }`)).toBe(true)
    expect(usesProviderAgentDriver(`${imports} function make() { switch (${call}) { case 0: let ${binding}; } }`)).toBe(true)
  })

  it.each([
    ["codexDriver", `codexDriver()`],
    ["defineAgent", `defineAgent({ driver: "codex" })`],
    ["agent", `agent.codexDriver()`],
    ["capabilities", `defineAgent({ capabilities: [capabilities.title({ driver: "codex" })], driver: { model: "openai/gpt-5" } })`],
  ])("respects catch and switch bindings for %s", (binding, call) => {
    const imports = `import { codexDriver, defineAgent } from "@vite-hub/agent"; import * as agent from "@vite-hub/agent"; import * as capabilities from "@vite-hub/agent/capabilities";`
    expect(usesProviderAgentDriver(`${imports} try {} catch (${binding}) { ${call} }`)).toBe(false)
    expect(usesProviderAgentDriver(`${imports} switch (value) { case 0: let ${binding}; break; case 1: ${call}; }`)).toBe(false)
    expect(usesProviderAgentDriver(`${imports} switch (value) { case 0: let ${binding}; break; case 1: ${call}; } ${call}`)).toBe(true)
    expect(usesProviderAgentDriver(`${imports} switch (${call}) { case 0: let ${binding}; }`)).toBe(true)
  })

  it.each([
    ["codexDriver", "codexDriver()"],
    ["defineAgent", `defineAgent({ driver: "codex" })`],
    ["agent", "agent.codexDriver()"],
    ["title", `defineAgent({ capabilities: [title({ driver: "codex" })] })`],
    ["capabilities", `defineAgent({ capabilities: [capabilities.title({ driver: "codex" })] })`],
  ])("respects static-block bindings for %s", async (binding, call) => {
    const imports = `import { codexDriver, defineAgent } from "@vite-hub/agent"; import * as agent from "@vite-hub/agent"; import { title } from "@vite-hub/agent/capabilities"; import * as capabilities from "@vite-hub/agent/capabilities";`
    const source = `${imports} class Setup { static { const ${binding} = localHelper; ${call} } }`
    expect(usesProviderAgentDriver(source)).toBe(false)
    await expect(transformServerModule(source, ["workerd", "worker"])).resolves.toBeUndefined()
    expect(usesProviderAgentDriver(`${imports} class Setup { static { ${call}; if (true) { var ${binding}; } } }`)).toBe(false)
    expect(usesProviderAgentDriver(`${source} ${call}`)).toBe(true)
    expect(usesProviderAgentDriver(`${source} class Other { static { ${call} } }`)).toBe(true)
  })

  it.each([
    ["codexDriver", "codexDriver()"],
    ["defineAgent", `defineAgent({ driver: "codex" })`],
    ["agent", "agent.codexDriver()"],
    ["title", `defineAgent({ capabilities: [title({ driver: "codex" })] })`],
    ["capabilities", `defineAgent({ capabilities: [capabilities.title({ driver: "codex" })] })`],
  ])("respects named class-expression bindings for %s", async (binding, call) => {
    const imports = `import { codexDriver, defineAgent } from "@vite-hub/agent"; import * as agent from "@vite-hub/agent"; import { title } from "@vite-hub/agent/capabilities"; import * as capabilities from "@vite-hub/agent/capabilities";`
    const source = `${imports} const Setup = class ${binding} { static driver = ${call}; method() { ${call} } };`
    expect(usesProviderAgentDriver(source)).toBe(false)
    await expect(transformServerModule(source, ["workerd", "worker"])).resolves.toBeUndefined()
    expect(usesProviderAgentDriver(`${source} ${call}`)).toBe(true)
    expect(usesProviderAgentDriver(`${source} class Other { static driver = ${call} }`)).toBe(true)
  })

  it.each(["title", "progressSummary"])("respects shadowed %s Capability imports", async (capability) => {
    const imports = `import { defineAgent } from "@vite-hub/agent"; import { ${capability} as makeCapability } from "@vite-hub/agent/capabilities";`
    const options = `{ capabilities: [makeCapability({ driver: "codex" })], driver: { model: "openai/gpt-5" } }`
    expect(usesProviderAgentDriver(`${imports} export default defineAgent(${options})`)).toBe(true)
    const parameterSource = `${imports} export const make = (makeCapability) => defineAgent(${options})`
    expect(usesProviderAgentDriver(parameterSource)).toBe(false)
    await expect(transformServerModule(parameterSource, ["workerd", "worker"])).resolves.toBeUndefined()
    expect(usesProviderAgentDriver(`${imports} { const makeCapability = customCapability; defineAgent(${options}) }`)).toBe(false)
    expect(usesProviderAgentDriver(`${imports} { const makeCapability = customCapability; defineAgent(${options}) } export default defineAgent(${options})`)).toBe(true)
  })

  it.each(["title", "progressSummary"])("respects shadowed %s Capability namespaces", async (capability) => {
    const imports = `import { defineAgent } from "@vite-hub/agent"; import * as capabilities from "@vite-hub/agent/capabilities";`
    const options = `{ capabilities: [capabilities.${capability}({ driver: "codex" })], driver: { run: () => "ok" } }`
    expect(usesProviderAgentDriver(`${imports} export default defineAgent(${options})`)).toBe(true)
    expect(usesProviderAgentDriver(`${imports} export const make = (capabilities: object) => defineAgent(${options})`)).toBe(false)
    const blockSource = `${imports} { const capabilities = customCapabilities; defineAgent(${options}) }`
    expect(usesProviderAgentDriver(blockSource)).toBe(false)
    await expect(transformServerModule(blockSource, ["workerd", "worker"])).resolves.toBeUndefined()
  })

  it("detects Worker resolve conditions", () => {
    expect(resolvesWorkerConditions(["workerd", "worker"])).toBe(true)
    expect(resolvesWorkerConditions(["worker"])).toBe(true)
    expect(resolvesWorkerConditions(["node", "import"])).toBe(false)
    expect(resolvesWorkerConditions(undefined)).toBe(false)
  })

  it("fails a Worker build that selects a provider Driver", async () => {
    await expect(transformServerModule(`import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: "codex" })`, ["workerd", "worker"]))
      .rejects.toMatchObject({ code: "AGENT_B0019" })
    await expect(transformServerModule(`import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: "codex" })`, ["workerd", "worker"]))
      .rejects.toThrow(/cannot run in a Cloudflare Worker\. Used in server\/agents\/support\.ts\./)
  })

  it("keeps provider Drivers in Node builds and model Drivers in Worker builds", async () => {
    await expect(transformServerModule(`import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: "codex" })`, ["node", "import"])).resolves.toBeUndefined()
    await expect(transformServerModule(`import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { model: "openai/gpt-5" } })`, ["workerd", "worker"])).resolves.toBeUndefined()
  })

  it("fails provider Driver calls that reach the Worker runtime", async () => {
    // SAFETY: The Worker module throws before it reads any option.
    expect(() => createProviderAgentAdapter({} as never)).toThrow(expect.objectContaining({ code: "AGENT_R0928" }))
    // SAFETY: The Worker module throws before it reads any option or context.
    expect(() => inspectAgentProvider({} as never, {} as never)).toThrow(/require a Node\.js host/)
  })
})
