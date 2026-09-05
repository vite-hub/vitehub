import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { discoverScheduleDefinitions } from "../src/discovery.ts"
import { createScheduleTargetsContents } from "../src/targets-module.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(source: string, server: boolean) {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-schedule-options-"))
  directories.push(rootDir)
  const directory = server ? join(rootDir, "server", "schedules") : rootDir
  await mkdir(directory, { recursive: true })
  const file = join(directory, server ? "daily.ts" : "daily.schedule.ts")
  await writeFile(file, source)
  return { file, discover: () => discoverScheduleDefinitions(server
    ? { mode: "server-schedules", scanDirs: [join(rootDir, "server")] }
    : { rootDir }) }
}

describe.each([false, true])("Schedule option discovery, server=%s", (server) => {
  it.each([
    "const allowed = true;\nexport default defineSchedule({ cron: '0 9 * * *', handler() {}, allowRuntimeSchedules: allowed })",
    "const options = { allowRuntimeSchedules: true };\nexport default defineSchedule({ ...options, cron: '0 9 * * *', handler() {} })",
    "const key = 'allowRuntimeSchedules';\nexport default defineSchedule({ [key]: true, cron: '0 9 * * *', handler() {} })",
    "const allowRuntimeSchedules = true;\nexport default defineSchedule({ allowRuntimeSchedules, cron: '0 9 * * *', handler() {} })",
    "export default defineSchedule({ get allowRuntimeSchedules() { return true }, cron: '0 9 * * *', handler() {} })",
  ])("rejects unsupported options instead of silently omitting a target", async (source) => {
    const { file, discover } = await fixture(source, server)
    expect(discover).toThrow(file)
    expect(discover).toThrow(/allowRuntimeSchedules.*literal|literal.*allowRuntimeSchedules/)
  })

  it("identifies an indirect default export at the definition call", async () => {
    const { file, discover } = await fixture("\nconst daily = defineScheduleTarget({ handler() {} }); export default daily", server)
    expect(discover).toThrow(`${file}:2:`)
    expect(discover).toThrow(/direct default export/)
  })

  it.each([true, false])("preserves literal opt-in %s in generated targets", async (allowed) => {
    const { discover } = await fixture(`export default defineSchedule({
      cron: '0 9 * * *',
      handler() { const nested = { ...{ allowRuntimeSchedules: !${allowed} } }; return nested },
      'allowRuntimeSchedules': ${allowed} /* explicit build option */,
    })`, server)
    const definitions = discover()
    expect(definitions).toMatchObject([{ name: "daily", allowRuntimeSchedules: allowed }])
    expect(createScheduleTargetsContents(definitions)).toContain(allowed ? '["daily"]' : '[]')
  })
})
