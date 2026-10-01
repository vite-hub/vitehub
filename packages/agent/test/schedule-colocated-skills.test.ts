import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { builtinModules } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import { expect, it, vi } from "vitest"
import { retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { prepareViteHubProviderSources } from "@vite-hub/internal/build/vite"

import { hubAgent } from "../src/vite.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

it.each(["default-expression", "default-binding", "default-reexport"])("preserves discovered Skills when a built Schedule directly extends an Agent (%s)", async (exportForm) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-colocated-skills-"))
  const seen: string[] = []
  vi.stubGlobal("__vitehubScheduleColocatedSkillsProof", seen)
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    const agentDir = join(root, "server", "agents", "reporter")
    await mkdir(join(agentDir, "skills", "review"), { recursive: true })
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(agentDir, "skills", "review", "SKILL.md"), "Review the report.")
    await writeFile(join(agentDir, exportForm === "default-reexport" ? "definition.ts" : "index.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "const reporter = defineAgent({ runtime: false, driver: { run: ({ context }) => { const text = new TextDecoder().decode(Object.values(context.get('agent.colocatedSkills') || {})[0]?.content); globalThis.__vitehubScheduleColocatedSkillsProof.push(text); return { text } } } })",
      exportForm === "default-binding" ? "export { reporter as default }" : "export default reporter",
    ].join("\n"))
    if (exportForm === "default-reexport") {
      await writeFile(join(agentDir, "index.ts"), "export { default } from './definition'")
    }
    await writeFile(join(root, "server", "schedules", "daily.ts"), [
      "import { defineAgent, runAgent } from '@vite-hub/agent'",
      "import { defineSchedule } from '@vite-hub/schedule'",
      "import reporter from '../agents/reporter/index'",
      "const daily = defineAgent({ extends: reporter, description: 'Daily report' })",
      "export default defineSchedule({ cron: '0 9 * * *', handler: async () => runAgent(daily, { runtime: 'unknown', memo: () => {}, waitUntil: () => {} }, { prompt: 'Write the report.' }) })",
    ].join("\n"))
    const plugin = hubAgent({ providers: { state: { provider: "memory" } } })
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [plugin],
      build: {
        ssr: join(root, "server", "schedules", "daily.ts"),
        outDir: join(root, "dist"),
        rolldownOptions: { external: /^@vite-hub\//, output: { entryFileNames: "daily.mjs" } },
      },
    })
    const schedule = await import(/* @vite-ignore */ pathToFileURL(join(root, "dist", "daily.mjs")).href)
    await expect(schedule.default.handler()).resolves.toMatchObject({ text: "Review the report." })
    const retained = await retainProviderOutputSources({ artifactDir: join(root, "snapshot"), roots: [root], paths: [join(root, "server", "schedules", "daily.ts")] })
    await prepareViteHubProviderSources([plugin], retained)
    const cronEntry = join(root, "deno-cron-input.mjs")
    await writeFile(cronEntry, [
      `import daily from ${JSON.stringify(retained.resolve(join(root, "server", "schedules", "daily.ts")))}`,
      "import { executeStaticSchedule } from '@vite-hub/schedule/runtime/static'",
      "Deno.cron('daily', '0 9 * * *', async () => { await executeStaticSchedule({ cron: '0 9 * * *', definition: daily, name: 'daily', scheduledAt: new Date() }) })",
    ].join("\n"))
    const cronOutput = join(root, "dist", "deno-cron.mjs")
    await bundleEsmEntry(cronEntry, cronOutput, {
      external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
      format: "esm",
      packages: "external",
      platform: "neutral",
      rootDir: root,
    })
    const crons: Array<() => Promise<void>> = []
    vi.stubGlobal("Deno", { cron: (_name: string, _cron: string, handler: () => Promise<void>) => { crons.push(handler) } })
    await import(/* @vite-ignore */ pathToFileURL(cronOutput).href)
    expect(crons).toHaveLength(1)
    await crons[0]!()
    expect(seen).toEqual(["Review the report.", "Review the report."])
  }
  finally {
    await rm(root, { recursive: true, force: true })
    vi.unstubAllGlobals()
  }
}, 30_000)
