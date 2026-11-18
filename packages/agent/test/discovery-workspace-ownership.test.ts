import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { parseAst } from "vite"

import { blob, db, transcribe, usage } from "../src/capabilities/index.ts"
import { github, telegram } from "../src/channels.ts"
import { discoverAgentDefinitions, discoverAgentOptionsStarts } from "../src/discovery.ts"
import { defineAgent } from "../src/index.ts"
import { withDeclaredAgentWorkspace } from "../src/server/internal.ts"
import { hubAgent } from "../src/vite.ts"

const fixtures = join(import.meta.dirname, "fixtures", "agent-workspace-ownership")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-ownership-"))
  roots.push(root)
  return root
}

async function stripTextSuffix(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await stripTextSuffix(path)
    else if (entry.name.endsWith(".txt")) await rename(path, path.slice(0, -".txt".length))
  }
}

function discover(root: string) {
  return discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })
    .map(({ name, source, workspace }) => ({ name, source, workspace }))
}

async function discoverProject(project: string) {
  const root = await createRoot()
  await cp(join(fixtures, project), root, { recursive: true })
  await stripTextSuffix(root)
  return discover(root)
}

async function discoverFolderAgent(source: string) {
  const root = await createRoot()
  await mkdir(join(root, "server", "agents", "review"), { recursive: true })
  await writeFile(join(root, "server", "agents", "review", "agent.ts"), source, "utf8")
  return discover(root)[0]?.workspace
}

describe("Agent Workspace discovery", () => {
  // The Agents of the projects that use ViteHub. An Agent owns a Workspace only when it declares `workspace`.
  it.each([
    ["vitehub-babysitter", [{ name: "babysitter", source: "server-agent-workspace", workspace: "babysitter" }]],
    ["quiver-agents", [
      { name: "bot", source: "server-agent-workspace", workspace: "bot" },
      { name: "bot-dev", source: "server-agent-workspace", workspace: "bot-dev" },
      { name: "duplicates", source: "server-agents", workspace: undefined },
    ]],
    ["bitacora", [{ name: "audio-bitacora", source: "server-agent-workspace", workspace: "audio-bitacora" }]],
    ["nuxt-agent", [{ name: "nuxt", source: "server-agent-workspace", workspace: "nuxt" }]],
    ["calories", [{ name: "calories", source: "server-agents", workspace: undefined }]],
    ["email-labeller", [{ name: "labeller", source: "server-agents", workspace: undefined }]],
    // Its github() Channel comes from a relative module with `pullRequest: false`, after a `String.raw` template and
    // templates that call functions.
    ["quiver-babysitter", [{ name: "babysitter", source: "server-agents", workspace: undefined }]],
    ["brief", [{ name: "summary", source: "server-agents", workspace: undefined }]],
  ])("discovers the Workspace of the %s Agents", async (project, expected) => {
    expect(await discoverProject(project)).toEqual(expected)
  })

  it.each([
    ["workspace: {}", "export default defineAgent({ workspace: {} })"],
    ["Workspace options", "export default defineAgent({ driver: { model }, workspace: { mode: 'write', sources } })"],
    ["a Workspace value", "export default defineAgent({ workspace: createWorkspace() })"],
    ["name: undefined", "export default defineAgent({ workspace: { name: undefined } })"],
    ["a const options object", "const options = { workspace: {} }\nexport default defineAgent(options)"],
    ["a const Agent", "const agent = defineAgent({ workspace: {} })\nexport default agent"],
    ["an export clause", "const agent = defineAgent({ workspace: {} })\nexport { agent as default }"],
    ["an alias", "import { defineAgent as agent } from 'vite-hub/agent'\nexport default agent({ workspace: {} })"],
    ["a const alias", "import { defineAgent } from 'vite-hub/agent'\nconst make = defineAgent\nexport default make({ workspace: {} })"],
    ["a chained const alias", "const create = defineAgent\nconst make = create\nexport default make({ workspace: {} })"],
    ["a namespace", "import * as hub from '@vite-hub/agent'\nexport default hub.defineAgent({ workspace: {} })"],
    ["type arguments", "export default defineAgent<Config>({ workspace: {} } satisfies Options)"],
    ["no default export", "export const review = defineAgent({ workspace: {} })"],
  ])("owns a Workspace with %s", async (_label, source) => {
    expect(await discoverFolderAgent(source)).toBe("review")
  })

  it.each([
    ["no workspace key", "export default defineAgent({ driver: { model } })"],
    ["workspace: undefined", "export default defineAgent({ workspace: undefined })"],
    ["a Workspace name", "export default defineAgent({ workspace: 'shared' })"],
    ["a const Workspace name", "const shared = 'shared'\nexport default defineAgent({ workspace: shared })"],
    ["a chained const Workspace name", "const shared = 'shared'\nconst ref = shared\nexport default defineAgent({ workspace: ref })"],
    ["a const reference name", "const name = 'shared'\nexport default defineAgent({ workspace: { name } })"],
    ["a const Workspace reference", "const name = 'shared'\nconst reference = { name, mode: 'write' }\nexport default defineAgent({ workspace: reference })"],
    ["a Workspace reference", "export default defineAgent({ workspace: { name: 'shared', mode: 'write' } })"],
    ["a GitHub pull request Channel", "import { github } from 'vite-hub/agent/channels'\nexport default defineAgent({ channels: { github: github({ pullRequest: true }) } })"],
    ["a parent with a Workspace", "const parent = defineAgent({ workspace: {} })\nexport default defineAgent({ extends: parent })"],
    ["a local defineAgent", "function defineAgent(options) { return options }\nexport default defineAgent({ workspace: {} })"],
    ["defineAgent from another package", "import { defineAgent } from 'other'\nexport default defineAgent({ workspace: {} })"],
  ])("owns no Workspace with %s", async (_label, source) => {
    expect(await discoverFolderAgent(source)).toBeUndefined()
  })

  it("keeps the nested Agents of an Agent that references a shared Workspace", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "agents", "review", "workspace"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review", "agent.ts"), "const name = 'shared'\nexport default defineAgent({ workspace: { name } })", "utf8")
    await writeFile(join(root, "server", "agents", "review", "workspace", "agent.ts"), "export default defineAgent({ workspace: {} })", "utf8")
    expect(discover(root)).toEqual([
      { name: "review", source: "server-agents", workspace: undefined },
      { name: "review/workspace", source: "server-agent-workspace", workspace: "review/workspace" },
    ])
  })

  // The forms that the Channel list reader found before it read only the `workspace` key.
  const hooks = "{ channels: ['hooks'] }"
  it.each([
    ["a const alias", `import { defineAgent } from 'vite-hub/agent'\nconst make = defineAgent\nexport default make(${hooks})`],
    ["a let alias", `let make = defineAgent\nexport default make(${hooks})`],
    ["a chained alias", `const create = defineAgent\nconst make = create\nexport default make(${hooks})`],
    ["a namespace alias", `import * as hub from 'vite-hub/agent'\nconst make = hub.defineAgent\nexport default make(${hooks})`],
    ["a function-local alias", `function make() {\n  const create = defineAgent\n  return create(${hooks})\n}\nexport default make()`],
    ["function-local options", `function make() {\n  const options = ${hooks}\n  return defineAgent(options)\n}\nexport default make()`],
    ["arrow-local options", `const make = () => {\n  const options = ${hooks}\n  return defineAgent(options)\n}\nexport default make()`],
    ["chained const options", `const base = ${hooks}\nconst options = base\nexport default defineAgent(options)`],
    ["let options", `let options = ${hooks}\nexport default defineAgent(options)`],
    ["var options", `var options = ${hooks}\nexport default defineAgent(options)`],
    ["options that shadow outer options", `const options = { channels: ['outer'] }\nfunction make() {\n  const options = ${hooks}\n  return defineAgent(options)\n}\nexport default make()`],
  ])("reads the options of a defineAgent() call through %s", (_label, source) => {
    expect([...discoverAgentOptionsStarts(source, "agent.ts")]).toEqual([source.indexOf(hooks)])
  })

  it.each([
    ["reassigned options", `let options = ${hooks}\noptions = {}\nexport default defineAgent(options)`],
    ["a parameter", `function make(options) { return defineAgent(options) }\nexport default make(${hooks})`],
    ["a shadowed defineAgent", `function make(defineAgent) { return defineAgent(${hooks}) }\nexport default make()`],
    ["an Agent value", `const agent = defineAgent({})\nexport default agent(${hooks})`],
  ])("reads no options through %s", (_label, source) => {
    expect([...discoverAgentOptionsStarts(source, "agent.ts")].filter(start => source.startsWith(hooks, start))).toEqual([])
  })

  it("reads the options of each defineAgent() call", () => {
    const source = [
      "import { defineAgent as agent } from 'vite-hub/agent'",
      "const options = { channels: ['slack'] }",
      "export const first = agent(options)",
      "export default agent({ channels: ['teams'] })",
      "other({ channels: ['ignored'] })",
    ].join("\n")
    expect([...discoverAgentOptionsStarts(source, "agent.ts")]).toEqual([
      source.indexOf("{ channels: ['slack'] }"),
      source.indexOf("{ channels: ['teams'] }"),
    ])
  })
})

describe("declared Agent Workspace", () => {
  it("fails for an Agent that gets a Workspace without the workspace key", () => {
    const agent = defineAgent({ channels: { github: github({ pullRequest: true }) }, driver: { run: () => "ok" } })
    expect(() => withDeclaredAgentWorkspace(agent, "reviewer")).toThrowError(expect.objectContaining({
      code: "AGENT_R1037",
      message: expect.stringContaining("Add workspace: {} to its defineAgent() options."),
    }))
  })

  it("keeps an Agent whose defineAgent() options have the workspace key", () => {
    const parent = defineAgent({ driver: { run: () => "ok" }, workspace: {} })
    const declared = defineAgent({ channels: { github: github({ pullRequest: true }) }, driver: { run: () => "ok" }, workspace: {} })
    const extended = defineAgent({ extends: parent, workspace: { mode: "write" } })
    expect(withDeclaredAgentWorkspace(parent, "parent")).toBe(parent)
    expect(withDeclaredAgentWorkspace(declared, "reviewer")).toBe(declared)
    expect(withDeclaredAgentWorkspace(extended, "extended")).toBe(extended)
  })

  it("fails for an Agent that gets its Workspace from a parent", () => {
    const parent = defineAgent({ driver: { run: () => "ok" }, workspace: {} })
    expect(() => withDeclaredAgentWorkspace(defineAgent({ extends: parent }), "child")).toThrowError(expect.objectContaining({ code: "AGENT_R1037" }))
  })

  it("keeps an Agent that declares no Workspace", () => {
    const named = defineAgent({ driver: { run: () => "ok" }, workspace: "shared" })
    expect(withDeclaredAgentWorkspace(named, "reviewer")).toBe(named)
  })

  // The runtime shapes of the calories and quiver-babysitter Agents, which have no workspace key.
  it("keeps the project Agents without a workspace key", () => {
    const calories = defineAgent({
      capabilities: [blob({ mode: "write" }), db({ mode: "write" }), transcribe({ execute: () => "text" }), usage()],
      channels: { telegram: telegram({ botToken: () => "token", webhookSecret: () => false }) },
      driver: { run: () => "ok" },
    })
    const babysitter = defineAgent({
      channels: { github: github({ app: true, pullRequest: false, webhooks: true }) },
      driver: { run: () => "ok" },
    })
    expect(withDeclaredAgentWorkspace(calories, "calories")).toBe(calories)
    expect(withDeclaredAgentWorkspace(babysitter, "babysitter")).toBe(babysitter)
  })
})

describe("Agent plugin", () => {
  it("checks the Workspace of folder Agents without the workspace key when they load", async () => {
    const root = await createRoot()
    const agents = join(root, "server", "agents")
    const files = {
      docs: join(agents, "docs", "agent.ts"),
      review: join(agents, "review", "agent.ts"),
      support: join(agents, "support.ts"),
    }
    const sources = {
      docs: "import { defineAgent } from 'vite-hub/agent'\nexport default defineAgent({ workspace: {} })",
      review: "import { defineAgent } from 'vite-hub/agent'\nimport { github } from 'vite-hub/agent/channels'\nexport default defineAgent({ channels: { github: github({ pullRequest: true }) } })",
      support: "import { defineAgent } from 'vite-hub/agent'\nexport default defineAgent({ driver: { model: 'model' } })",
    }
    await mkdir(join(agents, "docs"), { recursive: true })
    await mkdir(join(agents, "review"), { recursive: true })
    await Promise.all(Object.entries(files).map(([name, file]) => writeFile(file, sources[name as keyof typeof sources], "utf8")))
    const plugin = hubAgent()
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      command: "serve",
      createResolver: () => async () => undefined,
      plugins: [],
      root,
    })
    const transformHook = typeof plugin.transform === "function" ? plugin.transform : plugin.transform!.handler
    const transform = (name: keyof typeof files) => (transformHook as (...args: unknown[]) => Promise<string | undefined>)
      .call({ parse: parseAst }, sources[name], files[name])

    expect(await transform("review")).toContain("export default vitehubWithDiscoveredAgentName(vitehubWithDeclaredAgentWorkspace(defineAgent({ channels: { github: github({ pullRequest: true }) } }), \"review\"), \"review\")")
    expect(await transform("docs")).not.toContain("vitehubWithDeclaredAgentWorkspace")
    expect(await transform("support")).not.toContain("vitehubWithDeclaredAgentWorkspace")
  })

  it("registers the listed Channels of an Agent that calls defineAgent() through an alias", async () => {
    const root = await createRoot()
    const file = join(root, "server", "agents", "support.ts")
    const source = "import { defineAgent } from 'vite-hub/agent'\nconst make = defineAgent\nexport default make({ channels: ['hooks'], driver: { run: () => 'ok' } })"
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await mkdir(join(root, "server", "channels"), { recursive: true })
    await writeFile(file, source, "utf8")
    await writeFile(join(root, "server", "channels", "hooks.ts"), "import { defineChannel, webhook } from 'vite-hub/channels'\nexport default defineChannel({ adapter: webhook({ secret: false }) })", "utf8")
    const plugin = hubAgent()
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      command: "serve",
      createResolver: () => async () => undefined,
      plugins: [],
      root,
    })
    const transformHook = typeof plugin.transform === "function" ? plugin.transform : plugin.transform!.handler
    const transformed = await (transformHook as (...args: unknown[]) => Promise<string | undefined>).call({ parse: parseAst }, source, file)
    expect(transformed).toContain("vitehubRegisterAgentChannels({ [\"hooks\"]: vitehubChannel0 })")
  })
})
