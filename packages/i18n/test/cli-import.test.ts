import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRecord } from "@diglot/core"
import { writeRecord } from "@diglot/store"
import { formatter as poFormatter } from "@lingui/format-po"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { createI18nCliContributor } from "../src/cli.ts"
import { createLinguiConfig } from "../src/lingui.ts"
import { resolveI18nLocaleConfig } from "../src/locales.ts"
import { messageId, messageSegment, readRecords, saveTranslation } from "../src/records.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"

const recordIO = vi.hoisted(() => ({ pause: undefined as undefined | (() => Promise<void>) }))

vi.mock("@diglot/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@diglot/store")>()
  return {
    ...actual,
    readRecord: async (...args: Parameters<typeof actual.readRecord>) => {
      const pause = recordIO.pause
      recordIO.pause = undefined
      await pause?.()
      return actual.readRecord(...args)
    },
  }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-po-"))
  await writeFile(join(root, "label.ts"), 'import { t } from "@vite-hub/i18n"; export const label = t`Save`')
})

afterEach(async () => {
  recordIO.pause = undefined
  await rm(root, { recursive: true, force: true })
})

async function cli(...args: string[]) {
  const config = createLinguiConfig({ rootDir: root, locale: resolveI18nLocaleConfig({ locales: ["en", "es"] }), importBase: "@vite-hub/i18n" })
  const [namespace] = createI18nCliContributor(() => config).namespaces!
  const feature = namespace!.features.find(entry => entry.name === args[0])!
  let stdout = ""
  const context = {
    cwd: root,
    rootDir: root,
    env: {},
    stdout: { write: (chunk: string) => { stdout += chunk } },
    stderr: { write: () => {} },
  } as unknown as ViteHubCliContext
  return { code: await feature.run(args.slice(1), context) ?? 0, stdout }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => resolve = done)
  return { promise, resolve }
}

it("exports every translator note collected for a message", async () => {
  await writeFile(join(root, "label.ts"), 'import { t } from "@vite-hub/i18n"; export const label = t({ message: "Save", comment: "Saves the current file" })')
  await writeFile(join(root, "toolbar.ts"), 'import { t } from "@vite-hub/i18n"; export const label = t({ message: "Save", comment: "Action in the toolbar" })')
  const exported = await cli("export", "es")
  expect(exported.code).toBe(0)
  const catalog = await poFormatter().parse(exported.stdout, { locale: "es", sourceLocale: "en", filename: "es.po" })
  expect(catalog[messageId("Save")]!.comments).toEqual(expect.arrayContaining([
    "Saves the current file",
    "Action in the toolbar",
    "vitehub-i18n-expected: null",
  ]))
})

it.each([null, "Guardar"])("refuses a stale PO edit exported with %j", async (baseline) => {
  const records = join(root, "locales")
  if (baseline !== null) await saveTranslation(records, "es", { message: "Save" }, baseline, { by: "ana", expected: null })
  expect((await cli("export", "es", "--output", "es.po")).code).toBe(0)
  const po = await readFile(join(root, "es.po"), "utf8")
  await writeFile(join(root, "es.po"), po.replace(`msgid "Save"\nmsgstr ${JSON.stringify(baseline ?? "")}`, 'msgid "Save"\nmsgstr "Salvar"'))
  expect((await saveTranslation(records, "es", { message: "Save" }, "Conservar", { by: "luis", expected: baseline })).ok).toBe(true)

  const imported = await cli("import", "es", "es.po", "--json")
  expect(imported.code).toBe(1)
  expect(JSON.parse(imported.stdout)).toMatchObject({ saved: 0, refused: [{ message: "Save", problem: expect.stringContaining("changed") }] })
  expect((await readRecords(records, "es")).records[messageId("Save")]!.text).toBe("Conservar")
})

it("keeps the baseline through a PO editor round trip and allows repeated imports", async () => {
  const records = join(root, "locales")
  const baseline = 'Guardar "ahora"\npor favor'
  await saveTranslation(records, "es", { message: "Save" }, baseline, { by: "ana", expected: null })
  await cli("export", "es", "--output", "es.po")
  const options = { locale: "es", sourceLocale: "en", filename: join(root, "es.po") }
  const formatter = poFormatter()
  const catalog = await formatter.parse(await readFile(options.filename, "utf8"), options)
  Object.values(catalog)[0]!.translation = "Conservar"
  await writeFile(options.filename, await formatter.serialize(catalog, { ...options, existing: undefined }))

  expect(JSON.parse((await cli("import", "es", "es.po", "--json")).stdout)).toMatchObject({ saved: 1, refused: [] })
  expect(JSON.parse((await cli("import", "es", "es.po", "--json")).stdout)).toMatchObject({ saved: 0, unchanged: 1, refused: [] })
  expect((await readRecords(records, "es")).records[messageId("Save")]!.text).toBe("Conservar")
})

it("lets a PO file without a baseline add translations but refuses to overwrite them", async () => {
  const po = 'msgid "Save"\nmsgstr "Guardar"\n'
  await writeFile(join(root, "es.po"), po)
  expect((await cli("import", "es", "es.po")).code).toBe(0)
  await writeFile(join(root, "es.po"), po.replace("Guardar", "Salvar"))
  expect((await cli("import", "es", "es.po")).code).toBe(1)
  expect((await readRecords(join(root, "locales"), "es")).records[messageId("Save")]!.text).toBe("Guardar")
})

it.each(["missing", "rejected", "invalid"])("keeps the target baseline when reviewing a fuzzy draft for a %s record", async (state) => {
  const message = "Search all agents"
  await writeFile(join(root, "label.ts"), `import { t } from "@vite-hub/i18n"; export const label = t({ message: "${message}", comment: "Search across all agents" })`)
  const records = join(root, "locales")
  await saveTranslation(records, "es", { message: "Search agents" }, "Buscar agentes", { by: "ana", expected: null })
  const baseline = state === "missing" ? null : state === "invalid" ? "Buscar {name}" : "Buscar todos los agentes"
  if (baseline !== null) {
    await writeRecord(records, "es", createRecord({
      segment: messageSegment(message),
      text: baseline,
      origin: "human",
      ...(state === "rejected" ? { review: "rejected", rejectedBy: { by: "ana", at: "2026-11-07T10:00:00.000Z" } } : {}),
    }))
  }
  await cli("export", "es", "--output", "es.po")
  const options = { locale: "es", sourceLocale: "en", filename: join(root, "es.po") }
  const formatter = poFormatter()
  const catalog = await formatter.parse(await readFile(options.filename, "utf8"), options)
  const entry = Object.values(catalog)[0]!
  expect(entry.translation).toBe("Buscar agentes")
  expect(entry.comments).toEqual(["Search across all agents", `vitehub-i18n-expected: ${JSON.stringify(baseline)}`, "Previous source: Search agents"])
  expect(JSON.parse((await cli("import", "es", "es.po", "--json")).stdout)).toMatchObject({ saved: 0, fuzzy: 1, refused: [] })
  expect((await readRecords(records, "es")).records[messageId(message)]?.text ?? null).toBe(baseline)

  entry.translation = "Buscar todos nuestros agentes"
  entry.extra = { flags: [] }
  await writeFile(options.filename, await formatter.serialize(catalog, { ...options, existing: undefined }))
  expect(JSON.parse((await cli("import", "es", "es.po", "--json")).stdout)).toMatchObject({ saved: 1, fuzzy: 0, refused: [] })
  expect((await readRecords(records, "es")).records[messageId(message)]!.text).toBe(entry.translation)

  await saveTranslation(records, "es", { message }, "Buscar cada agente", { by: "luis", expected: entry.translation })
  const stale = await cli("import", "es", "es.po", "--json")
  expect(stale.code).toBe(1)
  expect(JSON.parse(stale.stdout)).toMatchObject({ saved: 0, refused: [{ message, problem: expect.stringContaining("changed") }] })
  expect((await readRecords(records, "es")).records[messageId(message)]!.text).toBe("Buscar cada agente")
})

it("checks unchanged entries against the locked record after import starts", async () => {
  const records = join(root, "locales")
  await saveTranslation(records, "es", { message: "Save" }, "Guardar", { by: "ana", expected: null })
  await writeFile(join(root, "es.po"), [
    '#. vitehub-i18n-expected: null',
    'msgid "Continue"',
    'msgstr "Continuar"',
    '',
    '#. vitehub-i18n-expected: "Guardar"',
    'msgid "Save"',
    'msgstr "Guardar"',
    '',
  ].join("\n"))
  const started = deferred()
  const release = deferred()
  // Hold the first entry inside its record lock while a translator changes the next entry.
  recordIO.pause = async () => {
    started.resolve()
    await release.promise
  }
  const importing = cli("import", "es", "es.po", "--json")
  try {
    await started.promise
    expect((await saveTranslation(records, "es", { message: "Save" }, "Conservar", { by: "luis", expected: "Guardar" })).ok).toBe(true)
  }
  finally {
    release.resolve()
  }
  const imported = await importing
  expect(imported.code).toBe(1)
  expect(JSON.parse(imported.stdout)).toMatchObject({ saved: 1, unchanged: 0, refused: [{ message: "Save", problem: expect.stringContaining("changed") }] })
  expect((await readRecords(records, "es")).records[messageId("Save")]!.text).toBe("Conservar")
})
