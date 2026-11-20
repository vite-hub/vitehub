import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createEmulator } from "emulate"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { codexDriver, defineAgent, runAgent } from "../src/index.ts"

import type { Emulator } from "emulate"

// Install `@openai/codex@0.169.0` in this package, or put that `codex` on PATH, then set VITEHUB_TEST_REAL_CODEX=1.
const realCodex = it.runIf(Boolean(process.env.VITEHUB_TEST_REAL_CODEX))
const secretNames = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/
const credentialRead = (what: string) => new Error(`An emulated run read the credential ${what}.`)
const originalEnv = process.env
const cleanup: Array<() => Promise<void>> = []
let emulator: Emulator | undefined

beforeEach(() => {
  // An emulated run must not read an AI key, and Codex must not get one.
  const env = Object.fromEntries(Object.entries(originalEnv).filter(([name]) => !secretNames.test(name)))
  process.env = new Proxy(env, {
    get(target, name) {
      if (typeof name === "string" && secretNames.test(name)) throw credentialRead(name)
      return Reflect.get(target, name)
    },
  })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  process.env = originalEnv
  for (const close of cleanup.splice(0).reverse()) await close()
  await emulator?.close()
  emulator = undefined
})

realCodex("runs a Codex Agent without tools on the AI emulator with the scripted reply", async () => {
  emulator = await createEmulator({
    service: "ai",
    port: 0,
    seed: { ai: { strict: true, rules: [{ id: "codex-hello", match: { format: "openai-responses", textContains: "Hello" }, reply: [{ type: "text", text: "Hello from the emulator." }] }] } },
  })
  vi.stubEnv("VITEHUB_MODELS", "emulate")
  vi.stubEnv("VITEHUB_EMULATE_URL", emulator.url)
  await mkdir(".vitest-tmp", { recursive: true })
  const root = await mkdtemp(resolve(".vitest-tmp", "emulate-codex-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  await writeFile(resolve(root, "README.md"), "Emulated Codex run.\n")

  const agent = defineAgent({
    name: "emulated-codex",
    runtime: false,
    driver: codexDriver({
      model: "gpt-5.5",
      cwd: root,
      credentials: () => { throw credentialRead("driver.credentials") },
      instructions: "Answer briefly.",
    }),
  })
  const [error, result] = await runAgent(agent, { prompt: "Hello", timeout: 60_000 })

  expect(error).toBeUndefined()
  expect(result?.text).toContain("Hello from the emulator.")
  const calls = await (await fetch(`${emulator.url}/_ai/calls`)).json() as Array<{ format: string, model: string, matched: { id?: string } | null }>
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) expect(call).toMatchObject({ format: "openai-responses", model: "gpt-5.5", matched: { id: "codex-hello" } })
}, 90_000)
