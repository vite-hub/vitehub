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

async function fixture(source: string, server: boolean, extension = ".ts") {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-schedule-options-"))
  directories.push(rootDir)
  const directory = server ? join(rootDir, "server", "schedules") : rootDir
  await mkdir(directory, { recursive: true })
  const file = join(directory, `${server ? "daily" : "daily.schedule"}${extension}`)
  await writeFile(file, source)
  return { file, discover: () => discoverScheduleDefinitions(server
    ? { mode: "server-schedules", scanDirs: [join(rootDir, "server")] }
    : { rootDir }) }
}

describe("Schedule JSX discovery", () => {
  it.each([
    "<T extends Email>(value: T) => value",
    "<T = Email>(value: T) => value",
    "<T extends () => Email>(value: T) => value",
    "<T extends Email>(value: T): Email => value",
    "<const T extends Email>(value: T) => value",
  ])("reads metadata after a server TSX generic arrow: %s", async (arrow) => {
    const { discover } = await fixture(`const first = ${arrow};\nexport default defineSchedule({ cron: '0 9 * * *', handler() {}, manual: true, allowRuntimeSchedules: true });\nconst text = "</T></const>";`, true, ".tsx")
    expect(discover()).toMatchObject([{ name: "daily", manual: true, allowRuntimeSchedules: true }])
  })

  it.each([
    "<Email></Email>",
    '<Email /* " */></Email>',
    '<Email></Email /* " */>',
    '<Email / /* " */ >',
    '<Email child=<Button />>"</Email>',
    '<Email child=<><Button /></>>"</Email>',
    '< /* comment */>raw import(fake) {import(target)}</>',
    "<Email />",
    "<T extends />",
    "<Email<string>></Email>",
    "<Email<{ subject: string }>>{import(target)}</Email>",
    "<T>(value) =&gt; value</T>",
    "<T extends={Email}>(value) {() => value}</T>",
    "<><Email /></>",
    String.raw`<Email subject="C:\"></Email>`,
    `<Email></Email>*/['"]/u`,
    `<Email></Email> * /['"]/u`,
    "<Email></Email>*/ /",
    "<Email></Email>*/a/*value",
    "<Email></Email>*/a/*value*/b/",
    "<Email></Email>*/a/*value + 1 /* after */",
  ])("reads literal metadata from a server .tsx definition: %s", async (jsx) => {
    const { discover } = await fixture(`export default defineSchedule({ cron: '0 9 * * *', handler: () => ${jsx}, manual: true, allowRuntimeSchedules: true })`, true, ".tsx")
    expect(discover()).toMatchObject([{ name: "daily", manual: true, allowRuntimeSchedules: true }])
  })
})

describe.each([false, true])("Schedule option discovery, server=%s", (server) => {
  it.each([
    "++/['\"]/u.lastIndex",
    "--/['\"]/u.lastIndex",
    "(() => { let value; return value = ++/['\"]/u.lastIndex })()",
    "(() => { return --/['\"]/u.lastIndex })()",
    "count!++ / total",
    "count!-- / total",
  ])("reads metadata after an update expression: %s", async (value) => {
    const { discover } = await fixture(`export default defineSchedule({ cron: '0 9 * * *', handler: () => ${value}, manual: true, allowRuntimeSchedules: true })`, server)
    expect(discover()).toMatchObject([{ name: "daily", manual: true, allowRuntimeSchedules: true }])
  })

  it.each(['const text = "</Email>";', "/* </Email> */", "/* </Email> */ /* after */", "/* </Email> */ /* after; */", '/* </Email> */ /* after" */', "/* </Email> */ / /;", "/* </Email> */\nconst pattern = /Email/;"])("reads metadata after a TypeScript assertion with a later closing tag: %s", async (after) => {
    const { discover } = await fixture(`const first = <Email>value;\nexport default defineSchedule({ cron: '0 9 * * *', handler() {}, manual: true, allowRuntimeSchedules: true });\n${after}`, server)
    expect(discover()).toMatchObject([{ name: "daily", manual: true, allowRuntimeSchedules: true }])
  })

  it.each(["function task<T>() {}", "class Task<T> {}"])("reads metadata after a generic declaration: %s", async (declaration) => {
    const { discover } = await fixture(`${declaration}\n/['"]/u.test(value);\nexport default defineSchedule({ cron: '0 9 * * *', handler() {}, manual: true, allowRuntimeSchedules: true });`, server)
    expect(discover()).toMatchObject([{ name: "daily", manual: true, allowRuntimeSchedules: true }])
  })

  it("rejects positional runtime targets during discovery", async () => {
    const { discover } = await fixture('export default defineScheduleTarget("not-an-object", () => {})', server)
    expect(discover).toThrow(/literal options/)
  })

  it("discovers object-form runtime targets", async () => {
    const { discover } = await fixture("export default defineScheduleTarget({ handler() {} })", server)
    expect(discover()).toMatchObject([{ name: "daily", allowRuntimeSchedules: true, runtimeOnly: true }])
  })

  it.each([false, true])("discovers positional options %s without executing the handler", async (allowed) => {
    const { discover } = await fixture(`export default defineSchedule('0 9 * * *', () => { throw new Error('never execute') }, { manual: true, allowRuntimeSchedules: ${allowed} })`, server)
    expect(discover()).toMatchObject([{ name: "daily", allowRuntimeSchedules: allowed }])
  })

  it("discovers positional schedules without options", async () => {
    const { discover } = await fixture("export default defineSchedule('0 9 * * *', () => {})", server)
    expect(discover()).toMatchObject([{ name: "daily", allowRuntimeSchedules: false }])
  })

  it.each(["é", "𐐀", "a\u0301", "manualé", "manual\u200C", "allowRuntimeSchedules\u200D"])("accepts an unrelated Unicode option key: %s", async (name) => {
    for (const source of [
      `export default defineSchedule({ ${name}: true, cron: '0 9 * * *', handler() {} })`,
      `export default defineSchedule('0 9 * * *', () => {}, { ${name}: true })`,
    ]) {
      const { discover } = await fixture(source, server)
      expect(discover()).toMatchObject([{ name: "daily", manual: false, allowRuntimeSchedules: false }])
    }
  })

  it.each(["0x2a", "1e2", "1_000", ".5", "1.5", "1e+2", "1e-2", "1.", "1_000.5_2", "0b1010", "0o52", "42n"])("accepts an unrelated numeric option key: %s", async (name) => {
    const { discover } = await fixture(`export default defineSchedule('0 9 * * *', () => {}, { ${name}: true, manual: true, allowRuntimeSchedules: true })`, server)
    expect(discover()).toMatchObject([{ name: "daily", manual: true, allowRuntimeSchedules: true }])
  })

  it.each([
    "(({ manual: true, allowRuntimeSchedules: true }))",
    "{ manual: true, allowRuntimeSchedules: true } as const",
  ])("discovers normalized positional literal options: %s", async (options) => {
    const { discover } = await fixture(`export default defineSchedule('0 9 * * *', () => {}, ${options})`, server)
    const definitions = discover()
    expect(definitions).toMatchObject([{ name: "daily", manual: true, allowRuntimeSchedules: true }])
    expect(createScheduleTargetsContents(definitions)).toContain('["daily"]')
  })

  it.each([
    "const options = {}; export default defineSchedule('0 9 * * *', () => {}, options)",
    "export default defineSchedule('0 9 * * *', () => {}, { ...options })",
  ])("rejects unresolved positional options", async (source) => {
    const { discover } = await fixture(source, server)
    expect(discover).toThrow(/literal/)
  })

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

  it.each([
    "get 'manual'() { return true }",
    '"manual"() { return true }',
    "get /* option */ 'allowRuntimeSchedules'() { return true }",
    '"allowRuntimeSchedules"() { return true }',
  ])("rejects quoted metadata getters and methods: %s", async (property) => {
    for (const source of [
      `export default defineSchedule({ cron: '0 9 * * *', handler() {}, ${property} })`,
      `export default defineSchedule('0 9 * * *', () => {}, { ${property} })`,
    ]) {
      const { file, discover } = await fixture(source, server)
      expect(discover).toThrow(file)
      expect(discover).toThrow(/literal true or false/)
    }
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
