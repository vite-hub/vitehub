import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import { retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { prepareViteHubProviderSources } from "@vite-hub/internal/build/vite"

import { hubAgent } from "../src/vite.ts"

it.each([
  { explicit: false, skills: false },
  { explicit: true, skills: false },
  { explicit: false, skills: true },
  { explicit: true, skills: true },
])("dispatches the discovered Workflow from a retained standalone Schedule (%j)", async ({ explicit, skills }) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-discovered-workflow-"))
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    const agentDir = join(root, "server/agents/reporter")
    const schedule = join(root, "server/schedules/daily.ts")
    await mkdir(agentDir, { recursive: true })
    await mkdir(join(root, "server/schedules"), { recursive: true })
    if (skills) {
      await mkdir(join(agentDir, "skills/review"), { recursive: true })
      await writeFile(join(agentDir, "skills/review/SKILL.md"), "Review the report.")
    }
    await writeFile(join(agentDir, "index.ts"), [
      "import { defineAgent, agentWorkflow } from '@vite-hub/agent'",
      `export default defineAgent({ ${explicit ? 'runtime: agentWorkflow("reporter"),' : ""} workspace: {}, driver: { run: () => 'inline' } })`,
    ].join("\n"))
    await writeFile(schedule, [
      "import { startAgentInvocation } from '@vite-hub/agent'",
      "import { defineSchedule } from '@vite-hub/schedule'",
      "import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from '@vite-hub/workflow/runtime/state'",
      "import reporter from '../agents/reporter/index'",
      "export default defineSchedule({ cron: '0 9 * * *', handler: async () => {",
      "  const calls = []",
      "  setWorkflowRuntimeConfig({ provider: 'cloudflare' })",
      "  setWorkflowRuntimeRegistry({ reporter: async () => ({ handler: () => { throw new Error('The discovered Workflow must dispatch to the provider') } }) })",
      "  try {",
      "    const result = await startAgentInvocation(reporter, { runtime: 'cloudflare', memo: (_key, create) => create(), waitUntil: () => {}, cloudflare: { env: {",
      "      WORKFLOW_7265706F72746572: { createBatch: async (batch) => { calls.push(...batch); return batch.map(({ id }) => ({ id })) } },",
      "    } } }, { prompt: 'Write the report.' })",
      "    return { result, calls }",
      "  } finally { resetWorkflowRuntime() }",
      "} })",
    ].join("\n"))
    const plugin = hubAgent({ providers: { state: { driver: "memory" } } })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, command: "build", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] } })
    const retained = await retainProviderOutputSources({ artifactDir: join(root, "snapshot"), roots: [root], paths: [schedule] })
    await prepareViteHubProviderSources([plugin], retained)
    const output = join(root, "dist/daily.mjs")
    await bundleEsmEntry(retained.resolve(schedule), output, { format: "esm", packages: "external", platform: "node", rootDir: root })
    // Only retained sources may supply the Agent's identity at runtime.
    await rm(join(root, "server"), { recursive: true })
    const built = await import(/* @vite-ignore */ pathToFileURL(output).href)
    await expect(built.default.handler()).resolves.toMatchObject({
      result: { id: expect.any(String) },
      calls: [{ id: expect.any(String), params: { agentIdentity: { name: "reporter", workspace: "reporter" }, input: { prompt: "Write the report." } } }],
    })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
