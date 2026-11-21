import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openai } from "@vite-hub/gateways"
import { languageModel } from "@vite-hub/gateways/ai-sdk"
import { describe, expect, it } from "vitest"

import { defineAgent } from "../src/index.ts"
import { runAgentInfoCli } from "../src/internal/agent-info-cli.ts"
import { loadViteAgent } from "../src/vite/runtime-adapter.ts"
import { resolveAgentInspectionMetadata } from "../src/workspace-agent.ts"

import type { ViteDevServer } from "vite"

function stream() {
  let output = ""
  return { get output() { return output }, write: (chunk: string | Uint8Array) => { output += String(chunk) } }
}

describe("discovered Agent inspection", () => {
  // nuxt-agent: a Workspace Agent in server/agents/<name>/ with a languageModel() Driver showed "Unknown Agent Driver".
  it("names the Driver of a discovered Workspace Agent in vitehub agent info", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-discovered-inspection-"))
    const handler = join(root, "nuxt", "agent.ts")
    try {
      await mkdir(join(root, "nuxt"), { recursive: true })
      await writeFile(handler, "export default {}", "utf8")
      await writeFile(join(root, "nuxt", "instructions.md"), "Answer Nuxt questions.\n", "utf8")
      const agent = defineAgent({
        driver: { model: languageModel(openai({ apiKey: "test" }), "gpt-5.6-terra", { api: "responses" }) },
        runtime: false,
        workspace: { sources: { notes: { content: "Notes.", workspacePath: "notes.md" } } },
      })
      const server = { config: { plugins: [] }, ssrLoadModule: async () => ({ default: agent }) } as unknown as ViteDevServer
      const loaded = await loadViteAgent(server, { handler, name: "nuxt" })

      const inspection = await resolveAgentInspectionMetadata(loaded!.agent as never)
      expect(inspection.config?.driver).toMatchObject({
        executionAuthority: { network: "none" },
        kind: "model",
        model: { id: "gpt-5.6-terra", provider: "openai.responses" },
      })

      const stdout = stream()
      const exitCode = await runAgentInfoCli(["--agent", "nuxt", "--url", "http://127.0.0.1:4731"], {
        env: {},
        rootDir: root,
        stderr: stream(),
        stdout,
      }, { fetch: (async () => Response.json({ inspection: { ...inspection, name: "nuxt" }, root })) as never })
      expect(exitCode).toBe(0)
      expect(stdout.output).toContain("Driver: Model-backed Agent Driver (gpt-5.6-terra)")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
