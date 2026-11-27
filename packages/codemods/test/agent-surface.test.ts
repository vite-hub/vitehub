import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, formatReport, runCodemod } from "../src/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/agent-surface-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function app(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  await writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies: { "vite-hub": "0.0.4" } }))
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(cwd, path, ".."), { recursive: true })
    await writeFile(join(cwd, path), source)
  }
  return cwd
}

async function migrated(source: string) {
  const cwd = await app({ "server/agent.ts": source })
  const run = await runCodemod("agent-surface", { cwd, dryRun: true })
  return { after: run.result.edits.find(edit => edit.path === "server/agent.ts")?.after, followUps: run.result.followUps.map(entry => entry.message) }
}

describe("agent-surface", () => {
  it("migrates the Agent names of a project", async () => {
    const input = join(fixtures, "agent-surface/input")
    const run = await runCodemod("agent-surface", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after ?? "(deleted)\n").toMatchFileSnapshot(join(fixtures, "agent-surface/output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, "agent-surface/output/report.txt"))
  })

  it("detects a project that uses an old Agent name", async () => {
    const cwd = await app({ "server/agents/bot/agent.ts": 'import { createLibsqlAgentState } from "vite-hub/agent/state/sqlite"\n' })
    expect((await detectCodemods(cwd)).find(entry => entry.codemod.name === "agent-surface")?.detection.reason).toBe("server/agents/bot/agent.ts uses an Agent API that was renamed")
    const current = await app({ "server/agents/bot/agent.ts": 'import { createLibsqlAgentState } from "vite-hub/agent/state"\n' })
    expect((await detectCodemods(current)).some(entry => entry.codemod.name === "agent-surface")).toBe(false)
  })

  it("keeps a local alias and merges a renamed type into an existing import", async () => {
    const { after } = await migrated('import { type AgentActor, type AgentInvoker, workflow as durable } from "vite-hub/agent"\nexport const runtime = durable("a")\nexport type Caller = AgentActor | AgentInvoker\n')
    expect(after).toBe('import { type AgentInvoker, agentWorkflow as durable } from "vite-hub/agent"\nexport const runtime = durable("a")\nexport type Caller = AgentInvoker | AgentInvoker\n')
  })

  it("renames reads through a namespace import", async () => {
    const { after } = await migrated('import * as agent from "@vite-hub/agent"\nexport const runtime = agent.workflow("a")\nexport const load = agent.getAgentFromRegistry\n')
    expect(after).toBe('import * as agent from "@vite-hub/agent"\nexport const runtime = agent.agentWorkflow("a")\nexport const load = agent.loadAgent\n')
  })

  it("keeps shadowed namespaces and nested callback parameters", async () => {
    const source = `import * as agent from "vite-hub/agent"
import { defineAgent } from "vite-hub/agent"
export const runtime = agent.workflow("host")
export function local(agent) { return agent.workflow("local") }
export default defineAgent({ driver: { run(context) {
  const nested = items.map(context => context.actor)
  const captured = items.map(() => context.actor)
  const sender = items.map(({ actor, input }) => actor)
  return [context.actor, nested, sender]
} } })
`
    const { after } = await migrated(source)
    expect(after).toBe(source.replace('agent.workflow("host")', 'agent.agentWorkflow("host")').replace('() => context.actor', '() => context.invoker').replace('[context.actor,', '[context.invoker,'))
  })

  it("changes only proven Agent inputs, options, and module strings", async () => {
    const source = `import { runAgent } from "vite-hub/agent"
import { vitehub } from "vite-hub"
import { hubAgent } from "@vite-hub/agent/vite"
import { vi } from "vitest"
const payload = { context: { actor: user } }
const settings = { agent: { providers: { state: { provider: "local" } } } }
const label = "vite-hub/agent/state/sqlite"
export const invocation = runAgent(bot, { context: { actor: user } })
export const host = vitehub({ agent: { providers: { state: { provider: "memory" } } } })
function local(runAgent, hubAgent) {
  runAgent(bot, { context: { actor: user } })
  return hubAgent({ providers: { state: { provider: "local" } } })
}
vi.mock("vite-hub/agent/state/sqlite")
export const store = import("vite-hub/agent/state/sqlite")
`
    const { after, followUps } = await migrated(source)
    expect(after).toBe(source
      .replace('export const invocation = runAgent(bot, { context: { actor:', 'export const invocation = runAgent(bot, { context: { invoker:')
      .replace('provider: "memory"', 'driver: "memory"')
      .replace('vi.mock("vite-hub/agent/state/sqlite")', 'vi.mock("vite-hub/agent/state")')
      .replace('import("vite-hub/agent/state/sqlite")', 'import("vite-hub/agent/state")'))
    expect(followUps.some(message => message.includes("Invocation"))).toBe(true)
  })

  it("detects actor-only callers for the umbrella migration", async () => {
    const cwd = await app({ "server/agent.js": 'import { runAgent } from "vite-hub/agent"\nrunAgent(bot, { context: { actor: user } })\n' })
    expect((await detectCodemods(cwd)).some(entry => entry.codemod.name === "agent-surface")).toBe(true)
  })

  it("reports a preset selection that it cannot read", async () => {
    const { after, followUps } = await migrated('import { defineAgent } from "vite-hub/agent"\nimport * as presets from "./presets"\nexport default defineAgent({ preset: process.env.PRESET!, presets })\n')
    expect(after).toBeUndefined()
    expect(followUps).toEqual(["`defineAgent()` has no `preset` or `presets` option. Pass the parent Agent Definition as `extends`."])
  })

  it("leaves an actor that can be a GitHub sender", async () => {
    const source = 'import { defineAgent } from "vite-hub/agent"\nexport default defineAgent({ hooks: { "agent:start"(event) { return event.trigger.actor.login } }, driver: { run: ({ actor }) => actor.login } })\n'
    const { after, followUps } = await migrated(source)
    expect(after).toBeUndefined()
    expect(followUps).toEqual(["Agent callbacks no longer receive `actor`. It was the same value as `invoker`; read `invoker` instead."])
  })

  it("renames the provider key only in Agent options", async () => {
    const cwd = await app({
      "vite.config.ts": 'import { hubAgent } from "@vite-hub/agent/vite"\nimport { hubQueue } from "@vite-hub/queue/vite"\nexport default { plugins: [hubAgent({ providers: { state: { provider: "libsql" }, sandbox: { provider: "vercel" } } }), hubQueue({ providers: { state: { provider: "x" } } })] }\n',
    })
    const run = await runCodemod("agent-surface", { cwd, dryRun: true })
    expect(run.result.edits[0]?.after).toBe('import { hubAgent } from "@vite-hub/agent/vite"\nimport { hubQueue } from "@vite-hub/queue/vite"\nexport default { plugins: [hubAgent({ providers: { state: { driver: "libsql" }, sandbox: { driver: "vercel" } } }), hubQueue({ providers: { state: { provider: "x" } } })] }\n')
  })
})
