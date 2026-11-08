import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { formatter as poFormatter } from "@lingui/format-po"
import { afterEach, beforeEach, expect, it } from "vitest"

import { createI18nCliContributor } from "../src/cli.ts"
import { createLinguiConfig } from "../src/lingui.ts"
import { resolveI18nLocaleConfig } from "../src/locales.ts"
import { messageId, readRecords, saveTranslation } from "../src/records.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-po-"))
  await writeFile(join(root, "label.ts"), 'import { t } from "@vite-hub/i18n"; export const label = t`Save`')
})

afterEach(async () => {
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
