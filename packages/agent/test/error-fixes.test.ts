import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { hubAgent } from "../src/vite.ts"

import type { AgentOptions } from "../src/types.ts"

const fixedCodes = [
  "AGENT_B0002",
  "AGENT_B0005",
  "AGENT_B0006",
  "AGENT_B0016",
  "AGENT_B0022",
  "AGENT_B0023",
  "AGENT_B0024",
  "AGENT_CHANNEL_HOST_NAME_TAKEN",
  "AGENT_CHANNEL_IMPORT_CYCLE",
  "AGENT_CHANNEL_NOT_FOUND",
  "AGENT_CHANNEL_WEBHOOK_PATH_TAKEN",
  "AGENT_ROUTE_NOT_STATIC",
  "AGENT_WEBHOOK_ALIAS_TARGET_INVALID",
  "AGENT_WEBHOOK_ROUTE_HOST_UNSUPPORTED",
] as const

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "agent-error-fixes-"))
  roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), source)
  }
  return root
}

const supportAgent = `import { defineAgent } from "vite-hub/agent"\nexport default defineAgent({ driver: { run: () => "" } })\n`

function build(root: string, options: AgentOptions, vitehub: Record<string, unknown> = {}) {
  const plugin = hubAgent(options)
  if (typeof plugin.config !== "function") throw new TypeError("Expected Agent config hook.")
  // SAFETY: The config hook reads only these fields of the Vite config in this test.
  plugin.config.call({} as never, { root, vitehub, nitro: {} } as never, { command: "build", mode: "production" } as never)
}

it("gives each Agent build code a fix and its own docs page", () => {
  const params = { agent: "a", channel: "c", channels: [], label: "l", message: "m", path: "/p", target: "a/w" }
  for (const code of fixedCodes) {
    const error = agentDiagnostics[code](params)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("names the alias option when an alias path is not static", async () => {
  const root = await project({ "server/agents/support.ts": supportAgent })
  expect(() => build(root, { routes: { aliases: { "/hooks/:id": { agent: "support", webhook: "github" } } } })).toThrow(expect.objectContaining({
    code: "AGENT_ROUTE_NOT_STATIC",
    fix: expect.stringContaining("routes: { aliases }"),
    message: "[vitehub] Agent webhook alias requires a static route path.",
  }))
})

it("names the alias entry fields when an alias has no target", async () => {
  const root = await project({ "server/agents/support.ts": supportAgent })
  expect(() => build(root, { routes: { aliases: { "/hooks/github": { agent: "", webhook: "github" } } } })).toThrow(expect.objectContaining({
    code: "AGENT_WEBHOOK_ALIAS_TARGET_INVALID",
    fix: expect.stringContaining("`agent` and `webhook`"),
  }))
})

it("names the Node host when a process host Agent builds for Vercel", async () => {
  const root = await project({
    "node_modules/@acme/host/package.json": JSON.stringify({ name: "@acme/host", vitehub: { agent: { processHost: ["./worker"] } } }),
    "server/agents/worker/agent.ts": `import { defineAgent } from "vite-hub/agent"\nimport { worker } from "@acme/host/worker"\nexport default defineAgent({ extends: worker })\n`,
  })
  expect(() => build(root, { providers: { state: { driver: "libsql", url: "libsql://state.example.test" } } }, { host: "vercel" })).toThrow(expect.objectContaining({
    code: "AGENT_B0022",
    fix: expect.stringContaining("vitehub({ host: \"node\" })"),
  }))
})
