import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEmulator } from "emulate"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("#vitehub/agent/registry", () => ({ default: {}, loadAgentHost: async () => {} }))

import { claudeCodeDriver, codexDriver, defineAgent } from "../src/index.ts"
import { runAgentEmulatorCli } from "../src/internal/agent-emulator-cli.ts"
import { runAgentInfoCli } from "../src/internal/agent-info-cli.ts"
import { createAgentHealth } from "../src/server/health.ts"
import { createAgentStatusReader } from "../src/server/provider-status.ts"

import type { Emulator } from "emulate"

function stream() {
  let output = ""
  return { get output() { return output }, write: (chunk: string | Uint8Array) => { output += String(chunk) } }
}

let emulator: Emulator
let url: string
let rootDir: string

beforeAll(async () => {
  emulator = await createEmulator({
    service: "ai",
    port: 0,
    seed: {
      ai: {
        rules: [
          { id: "greeting", match: { textContains: "Hello" }, times: 2, reply: [{ type: "text", text: "Hi." }] },
          { id: "always", match: { textContains: "weather" }, reply: [{ type: "text", text: "Sunny." }] },
        ],
      },
    },
  })
  url = emulator.url.replace("localhost", "127.0.0.1")
  rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-emulator-"))
})

afterAll(async () => {
  await emulator?.close()
  await rm(rootDir, { force: true, recursive: true })
})

beforeEach(async () => {
  await fetch(`${url}/_ai/reset`, { method: "POST" })
  for (const text of ["Hello there", "Something else"]) {
    await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.1", messages: [{ role: "user", content: text }] }),
    })
  }
})

describe("vitehub agent emulator", () => {
  it("prints the URL, the rules with their budget, and the calls with the rule that answered", async () => {
    const stdout = stream()
    const stderr = stream()
    const exitCode = await runAgentEmulatorCli([], { env: { VITEHUB_EMULATE_URL: url }, rootDir, stderr, stdout })

    expect(stderr.output).toBe("")
    expect(exitCode).toBe(0)
    const lines = stdout.output.split("\n")
    expect(lines[0]).toBe(`AI emulator: ${url}`)
    expect(stdout.output).toContain("Rules: 2")
    expect(lines.find(line => line.trim().startsWith("greeting"))).toMatch(/greeting\s+1 of 2\s+reply/)
    expect(lines.find(line => line.trim().startsWith("always"))).toMatch(/always\s+unlimited\s+reply/)
    expect(stdout.output).toContain("Calls: 2")
    expect(lines.find(line => line.trim().startsWith("1 "))).toMatch(/openai\/gpt-5\.1\s+openai-chat\s+200\s+greeting$/)
    expect(lines.find(line => line.trim().startsWith("2 "))).toMatch(/default \(echo\)$/)
  })

  it("prints the upstream shapes and the URL with --json", async () => {
    const stdout = stream()
    expect(await runAgentEmulatorCli(["--json"], { env: { VITEHUB_EMULATE_URL: url }, rootDir, stderr: stream(), stdout })).toBe(0)
    const printed = JSON.parse(stdout.output) as { url: string, rules: unknown, calls: unknown }
    expect(printed.url).toBe(url)
    expect(printed.rules).toEqual(await (await fetch(`${url}/_ai/rules`)).json())
    expect(printed.calls).toEqual(await (await fetch(`${url}/_ai/calls`)).json())
    expect(printed.calls).toMatchObject([{ matched: { id: "greeting", remaining: 1 } }, { matched: { default: "echo" } }])
  })

  it("finds the emulator through the Agent Dev Loop discovery of the dev server", async () => {
    const app = "http://127.0.0.1:4799"
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const target = String(input)
      if (target.startsWith(app)) {
        expect(target).toBe(`${app}/__vitehub/agent/invocation-stream`)
        return Response.json({ agents: [], emulator: { url }, root: rootDir })
      }
      return await fetch(input, init)
    })
    const stdout = stream()
    expect(await runAgentEmulatorCli(["--url", app], { env: { VITEHUB_EMULATE_URL: "http://127.0.0.1:9" }, rootDir, stderr: stream(), stdout }, { fetch: fetchImpl })).toBe(0)
    expect(stdout.output).toContain(`AI emulator: ${url}`)
  })

  it("fails with a coded diagnostic when no emulator runs", async () => {
    const noServer = stream()
    expect(await runAgentEmulatorCli([], { env: {}, rootDir, stderr: noServer, stdout: stream() })).toBe(1)
    expect(noServer.output).toContain("AGENT_EMULATOR_NOT_RUNNING")
    expect(noServer.output).toContain("VITEHUB_EMULATE_URL is not set, and no dev server of this project is running")

    const devServerWithout = stream()
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ agents: [], root: rootDir }))
    expect(await runAgentEmulatorCli(["--url", "http://127.0.0.1:4799"], { env: {}, rootDir, stderr: devServerWithout, stdout: stream() }, { fetch: fetchImpl })).toBe(1)
    expect(devServerWithout.output).toContain("the dev server at http://127.0.0.1:4799 does not run one")

    // Port 9 (discard) has no listener on a dev machine, so the request fails to connect.
    const closed = stream()
    expect(await runAgentEmulatorCli([], { env: { VITEHUB_EMULATE_URL: "http://127.0.0.1:9" }, rootDir, stderr: closed, stdout: stream() })).toBe(1)
    expect(closed.output).toContain("AGENT_EMULATOR_NOT_RUNNING")
  })
})

describe("inspection under VITEHUB_MODELS=emulate", () => {
  // A credential read fails the test: inspection of an emulated Agent must not read a key or a provider account.
  const secretNames = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/
  const credentialRead = (what: string) => new Error(`Inspection read the credential ${what}.`)
  const originalEnv = process.env

  beforeEach(() => {
    const env = Object.fromEntries(Object.entries(originalEnv).filter(([name]) => !secretNames.test(name)))
    process.env = new Proxy(env, {
      get(target, name) {
        if (typeof name === "string" && secretNames.test(name)) throw credentialRead(name)
        return Reflect.get(target, name)
      },
    })
    vi.stubEnv("VITEHUB_MODELS", "emulate")
    vi.stubEnv("VITEHUB_EMULATE_URL", url)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    process.env = originalEnv
  })

  const credentials = () => { throw credentialRead("driver.credentials") }

  it("reports provider status as emulated with the URL and reads no credentials", async () => {
    const agent = defineAgent({ name: "coder", runtime: false, driver: codexDriver({ credentials }) })
    const status = vi.spyOn(agent, "status")
    const readStatus = createAgentStatusReader()
    await expect(readStatus(agent, "coder")).resolves.toMatchObject({ agent: "coder", emulated: { url }, provider: "codex", readiness: "ready", stale: false })
    expect(status).not.toHaveBeenCalled()

    const model = defineAgent({ name: "support", runtime: false, driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1" } })
    await expect(readStatus(model, "support")).resolves.toMatchObject({ emulated: { url }, readiness: "ready" })

    const claude = defineAgent({ name: "reviewer", runtime: false, driver: claudeCodeDriver({ env: () => { throw credentialRead("driver.env") } }) })
    await expect(readStatus(claude, "reviewer")).resolves.toMatchObject({ emulated: { url }, provider: "claude-code", readiness: "unavailable" })

    const health = await createAgentHealth({ name: "coder", agent: () => agent })()
    expect(health.diagnostics).toContainEqual({ label: "Provider", status: "ok", value: "Emulated", detail: `AI emulator at ${url}` })
  })

  it("reports an emulated status as unavailable in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const agent = defineAgent({ name: "coder", runtime: false, driver: codexDriver({ credentials }) })
    await expect(createAgentStatusReader()(agent, "coder")).resolves.toMatchObject({ emulated: { url }, readiness: "unavailable", reason: expect.stringContaining("production") })
  })

  it("shows emulated models with the URL in agent info", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      emulator: { url },
      inspection: { name: "support", config: { driver: { kind: "model", model: { gateway: "emulate", id: "openai/gpt-5.1", provider: "emulate.responses" } } } },
      root: rootDir,
    }))
    const stdout = stream()
    expect(await runAgentInfoCli(["--url", "http://127.0.0.1:4799"], { env: {}, rootDir, stderr: stream(), stdout }, { fetch: fetchImpl })).toBe(0)
    expect(stdout.output).toContain(`Models: emulated by the AI emulator at ${url} (VITEHUB_MODELS=emulate)`)

    const json = stream()
    expect(await runAgentInfoCli(["--url", "http://127.0.0.1:4799", "--json"], { env: {}, rootDir, stderr: stream(), stdout: json }, { fetch: fetchImpl })).toBe(0)
    expect(JSON.parse(json.output)).toMatchObject({ emulator: { url } })
  })
})
