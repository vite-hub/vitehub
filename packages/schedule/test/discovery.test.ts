import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistryContents } from "@vitehub/internal/definition-discovery"
import { discoverScheduleDefinitions } from "../src/discovery.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  directories.push(rootDir)
  return rootDir
}

describe("discoverScheduleDefinitions", () => {
  it("creates a runtime registry file", async () => {
    const rootDir = await createTempDir("vitehub-schedule-registry-")
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    const sourceFile = join(rootDir, "welcome.schedule.ts")
    await writeFile(sourceFile, "export default null\n", "utf8")

    expect(createRuntimeRegistryContents(registryFile, [{
      handler: sourceFile,
      name: "welcome",
    }])).toContain('"welcome": async () => import(')
  })

  it("discovers schedule ids for Vite and Nitro entrypoints", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-vite-discovery-")
    await mkdir(join(viteRootDir, "src", "emails"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "emails", "digest.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(viteRootDir, "src", "billing.schedule.ts"), "export default null\n", "utf8")

    const nitroScanDir = await createTempDir("vitehub-schedule-nitro-discovery-")
    await mkdir(join(nitroScanDir, "schedules", "emails"), { recursive: true })
    await mkdir(join(nitroScanDir, "schedules", "billing"), { recursive: true })
    await writeFile(join(nitroScanDir, "schedules", "emails", "digest.ts"), "export default null\n", "utf8")
    await writeFile(join(nitroScanDir, "schedules", "billing", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(nitroScanDir, "schedules", "welcome.d.ts"), "export type Welcome = string\n", "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/digest",
    ])

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/digest",
    ])
  })

  it("uses explicit ids from defineSchedule options", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-explicit-id-")
    await writeFile(join(viteRootDir, "daily.schedule.ts"), "export default defineSchedule('0 9 * * *', () => {}, { id: 'reports/daily' })\n", "utf8")

    const nitroScanDir = await createTempDir("vitehub-schedule-nitro-explicit-id-")
    await mkdir(join(nitroScanDir, "schedules"), { recursive: true })
    await writeFile(join(nitroScanDir, "schedules", "daily.ts"), "export default defineSchedule('0 9 * * *', () => {}, { id: 'reports/daily' })\n", "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("discovers inline Agent Schedules from Agent capabilities", async () => {
    const viteRootDir = await createTempDir("vitehub-agent-schedule-vite-")
    await mkdir(join(viteRootDir, "src"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "support.agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export default defineAgent({",
      "  capabilities: [schedule({ schedules: ['0   9 * * *', { cron: '15 10 * * 1-5', id: 'weekday-digest' }] })],",
      "  run: () => 'ok',",
      "})",
    ].join("\n"), "utf8")

    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-")
    await mkdir(join(nitroScanDir, "agents", "support"), { recursive: true })
    await writeFile(join(nitroScanDir, "agents", "support", "config.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export default defineAgent({",
      "  capabilities: [schedule({ schedules: [{ cron: '0 12 * * *' }] })],",
      "  run: () => 'ok',",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    })).toEqual([
      expect.objectContaining({ agentName: "support", cron: "0 9 * * *", name: "support/schedule-0-9", source: "agent-inline-schedule" }),
      expect.objectContaining({ agentName: "support", cron: "15 10 * * 1-5", name: "support/weekday-digest", source: "agent-inline-schedule" }),
    ])

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentName: "support", cron: "0 12 * * *", name: "support/schedule-0-12", source: "agent-inline-schedule" }),
    ])
  })

  it("ignores quoted object keys in inline Agent Schedules", async () => {
    const viteRootDir = await createTempDir("vitehub-agent-schedule-quoted-")
    await mkdir(join(viteRootDir, "src"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "support.agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export default defineAgent({",
      "  capabilities: [schedule({ schedules: [{ \"cron\": \"0 9 * * *\", \"id\": \"daily\" }] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    })).toEqual([
      expect.objectContaining({ cron: "0 9 * * *", name: "support/daily" }),
    ])
  })

  it("discovers inline Agent Schedules from aliased schedule capabilities", async () => {
    const viteRootDir = await createTempDir("vitehub-agent-schedule-alias-")
    await mkdir(join(viteRootDir, "src"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "support.agent.ts"), [
      "import { defineAgent } from '@vitehub/agent'",
      "import { schedule as agentSchedule } from '@vitehub/agent/capabilities'",
      "export default defineAgent({",
      "  capabilities: [agentSchedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    })).toEqual([
      expect.objectContaining({ cron: "0 9 * * *", name: "support/schedule-0-9" }),
    ])
  })

  it("discovers inline Agent Schedules from namespace schedule capabilities", async () => {
    const viteRootDir = await createTempDir("vitehub-agent-schedule-namespace-")
    await mkdir(join(viteRootDir, "src"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "support.agent.ts"), [
      "import { defineAgent } from '@vitehub/agent'",
      "import * as agent from '@vitehub/agent/capabilities'",
      "export default defineAgent({",
      "  capabilities: [agent.schedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    })).toEqual([
      expect.objectContaining({ cron: "0 9 * * *", name: "support/schedule-0-9" }),
    ])
  })

  it("skips dependency directories during Vite inline Agent Schedule discovery", async () => {
    const viteRootDir = await createTempDir("vitehub-agent-schedule-skip-deps-")
    await mkdir(join(viteRootDir, "src"), { recursive: true })
    await mkdir(join(viteRootDir, "node_modules", "third-party"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "support.agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export default defineAgent({ capabilities: [schedule({ schedules: ['0 9 * * *'] })] })",
    ].join("\n"), "utf8")
    await writeFile(join(viteRootDir, "node_modules", "third-party", "support.agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export default defineAgent({ capabilities: [schedule({ schedules: ['0 10 * * *'] })] })",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    })).toEqual([
      expect.objectContaining({ cron: "0 9 * * *", name: "support/schedule-0-9" }),
    ])
  })

  it("binds Nitro aggregate inline Agent Schedules to the owning export", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-aggregate-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export const Support = defineAgent({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
      "export const Billing = defineAgent({",
      "  capabilities: [schedule({ schedules: [{ cron: '0 10 * * *', id: 'invoice-digest' }] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Billing", agentName: "Billing", cron: "0 10 * * *", name: "Billing/invoice-digest" }),
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("discovers Nitro aggregate inline Agent Schedules from export lists", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-export-list-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "const Support = defineAgent({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
      "export { Support }",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("discovers Nitro aggregate inline Agent Schedules from re-exported agents", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-re-export-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "export { Support } from './support'",
    ].join("\n"), "utf8")
    await writeFile(join(nitroScanDir, "support.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export const Support = defineAgent({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("discovers Nitro aggregate inline Agent Schedules from default re-exported agents", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-default-re-export-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "export { default as Support } from './support'",
    ].join("\n"), "utf8")
    await writeFile(join(nitroScanDir, "support.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export default defineAgent({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("discovers Nitro aggregate inline Agent Schedules from typed generic agents", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-generic-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export const Support: AgentDefinition = defineAgent<MyRuntime>({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("discovers Nitro aggregate inline Agent Schedules from nested generic agents", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-nested-generic-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export const Support = defineAgent<MyRuntime<Ctx>>({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("discovers Nitro aggregate inline Agent Schedules from function type generic agents", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-function-generic-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export const Support = defineAgent<(ctx: Ctx) => Out>({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("discovers typed aggregate inline Agent Schedules with generic commas", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-generic-commas-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export const Support: AgentDefinition<MyRuntime, CallOptions> = defineAgent({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("reads inline Agent Schedule object fields only at the top level", async () => {
    const viteRootDir = await createTempDir("vitehub-agent-schedule-top-level-fields-")
    await mkdir(join(viteRootDir, "src"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "support.agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export default defineAgent({",
      "  capabilities: [schedule({ schedules: [{ meta: { cron: '1 2 3 4 5', id: 'meta' }, cron: '0 9 * * *', id: 'daily' }] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    })).toEqual([
      expect.objectContaining({ cron: "0 9 * * *", name: "support/daily" }),
    ])
  })

  it("ignores local schedule functions that are not agent capabilities", async () => {
    const viteRootDir = await createTempDir("vitehub-agent-schedule-local-helper-")
    await mkdir(join(viteRootDir, "src"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "support.agent.ts"), [
      "import { defineAgent } from '@vitehub/agent'",
      "function schedule(options: unknown) { return options }",
      "export default defineAgent({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    })).toEqual([])
  })

  it("discovers all Nitro aggregate inline Agent Schedules from one declaration", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-multiple-declarators-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export const Support = defineAgent({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "}), Billing = defineAgent({",
      "  capabilities: [schedule({ schedules: ['0 10 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Billing", agentName: "Billing", cron: "0 10 * * *", name: "Billing/schedule-0-10" }),
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("ignores interpolated template cron strings in inline Agent Schedules", async () => {
    const viteRootDir = await createTempDir("vitehub-agent-schedule-template-")
    await mkdir(join(viteRootDir, "src"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "support.agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "const minute = 15",
      "export default defineAgent({",
      "  capabilities: [schedule({ schedules: [{ cron: `${minute} 9 * * *`, id: 'dynamic' }, { cron: `0 10 * * *`, id: 'static' }] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    })).toEqual([
      expect.objectContaining({ cron: "0 10 * * *", name: "support/static" }),
    ])
  })

  it("ignores interpolated template ids in inline Agent Schedules", async () => {
    const viteRootDir = await createTempDir("vitehub-agent-schedule-template-id-")
    await mkdir(join(viteRootDir, "src"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "support.agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "const tenant = 'acme'",
      "export default defineAgent({",
      "  capabilities: [schedule({ schedules: [{ cron: '0 9 * * *', id: `${tenant}-daily` }] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    })).toEqual([
      expect.objectContaining({ cron: "0 9 * * *", name: "support/schedule-0-9" }),
    ])
  })

  it("ignores non-agent exports before Nitro aggregate agents", async () => {
    const nitroScanDir = await createTempDir("vitehub-agent-schedule-nitro-non-agent-export-")
    await writeFile(join(nitroScanDir, "agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export const VERSION = '1.0.0'",
      "export const Support = defineAgent({",
      "  capabilities: [schedule({ schedules: ['0 9 * * *'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    })).toEqual([
      expect.objectContaining({ agentExportName: "Support", agentName: "Support", cron: "0 9 * * *", name: "Support/schedule-0-9" }),
    ])
  })

  it("uses explicit ids from quoted defineSchedule option keys", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-quoted-explicit-id-")
    await writeFile(join(viteRootDir, "daily.schedule.ts"), "export default defineSchedule('0 9 * * *', () => {}, { 'id': 'reports/daily' })\n", "utf8")
    await writeFile(join(viteRootDir, "weekly.schedule.ts"), "export default defineSchedule('0 9 * * 1', () => {}, { \"id\": \"reports/weekly\" })\n", "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily", "reports/weekly"])
  })

  it("ignores nested id fields when no defineSchedule id option is set", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-nested-id-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule('0 9 * * *', () => foo(1, { id: 'inner' }))\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["daily"])
  })

  it("reads ids from nested generic defineSchedule calls", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-nested-generic-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule<Promise<string>>('0 9 * * *', async () => 'ok', { id: 'reports/daily' })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("ignores commented defineSchedule examples during id discovery", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-commented-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "// defineSchedule('0 9 * * *', () => {}, { id: 'docs/example' })\nexport default defineSchedule('0 9 * * *', () => {}, { id: 'reports/daily' })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("preserves string literals while ignoring comments during id discovery", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-comment-string-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule('0 9 * * *', () => { const path = 'foo//bar' }, { id: 'reports/daily' })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("preserves regex literals while reading defineSchedule options", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-regex-literal-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule('0 9 * * *', () => /\\)/.test(')'), { id: 'reports/daily' })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("ignores nested id fields in defineSchedule options", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-nested-options-id-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule('0 9 * * *', () => {}, { retry: { id: 'nested' } })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["daily"])
  })


  it("rejects duplicate schedule ids across discovery roots and explicit ids", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-vite-duplicate-")
    const viteScanDir = await createTempDir("vitehub-schedule-vite-duplicate-scan-")
    await writeFile(join(viteRootDir, "welcome.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(viteScanDir, "daily.schedule.ts"), "export default defineSchedule('0 9 * * *', () => {}, { id: 'welcome' })\n", "utf8")

    expect(() => discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
      scanDirs: [viteScanDir],
    })).toThrow(/Duplicate schedule name/)

    const firstNitroScanDir = await createTempDir("vitehub-schedule-nitro-first-")
    const secondNitroScanDir = await createTempDir("vitehub-schedule-nitro-second-")
    await mkdir(join(firstNitroScanDir, "schedules"), { recursive: true })
    await mkdir(join(secondNitroScanDir, "schedules"), { recursive: true })
    await writeFile(join(firstNitroScanDir, "schedules", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(secondNitroScanDir, "schedules", "daily.ts"), "export default defineSchedule('0 9 * * *', () => {}, { id: 'welcome' })\n", "utf8")

    expect(() => discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [firstNitroScanDir, secondNitroScanDir],
    })).toThrow(/Duplicate schedule name/)
  })
})
