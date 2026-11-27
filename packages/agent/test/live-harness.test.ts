import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { cliproxy } from "@vite-hub/gateways"
import { defineAgent, opencodeDriver } from "../src/index.ts"
import { runAgentForTest } from "../src/test.ts"

const prompt = "Write hello.txt containing the word hi, then run cat hello.txt."

function binary(command: string): string {
  return execFileSync("which", [command], { encoding: "utf8" }).trim()
}

const harnesses = [
  ["opencode", (cwd: string) => opencodeDriver({ cwd, gateway: cliproxy(), model: process.env.VITEHUB_LIVE_OPENCODE_MODEL ?? "gpt-oss-120b-medium", permissions: "allow-all", providerSettings: { binaryPath: binary("opencode") } })],
] as const

describe.skipIf(process.env.VITEHUB_LIVE_HARNESS !== "1")("live harness turns through CLIProxy", () => {
  it.each(harnesses)("%s writes hello.txt in one turn", async (_harness, driver) => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-live-harness-"))
    try {
      await runAgentForTest(defineAgent({ driver: driver(cwd) }), { runtimeConfig: {} }, { prompt })
      expect(await readFile(join(cwd, "hello.txt"), "utf8")).toContain("hi")
    }
    finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 300_000)
})
