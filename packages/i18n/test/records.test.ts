import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { countWords, createRecord, hashSkeleton, parseRecord } from "@diglot/core"
import { writeManifest, writeRecord } from "@diglot/store"
import { afterEach, describe, expect, it } from "vitest"

import { compileMessages } from "../src/catalogs.ts"
import { messageId, messageSegment, readRecords, recordPath, saveTranslation, verifyTranslation } from "../src/records.ts"

import type { SegmentKind } from "@diglot/core"
import type { Manifest } from "@diglot/store"

const diglotBin = join(dirname(createRequire(import.meta.url).resolve("@diglot/cli/package.json")), "bin/diglot.mjs")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "i18n-records-"))
  roots.push(root)
  return root
}

interface DiglotIssue { locale: string, hash?: string, message: string }

/** Run `diglot validate` of `@diglot/cli` on a folder. */
async function diglotValidate(root: string): Promise<{ code: number, checked: number, errors: DiglotIssue[], warnings: DiglotIssue[] }> {
  const result = await promisify(execFile)(process.execPath, [diglotBin, "validate", "--cwd", root, "--locale", "es", "--json"])
    .then(output => ({ code: 0, stdout: output.stdout }), (error: { code: number, stdout: string }) => ({ code: error.code, stdout: error.stdout }))
  return { code: result.code, ...JSON.parse(result.stdout) as { checked: number, errors: DiglotIssue[], warnings: DiglotIssue[] } }
}

const messages = [
  { message: "Deploy your agent" },
  { message: "Save", context: "button" },
  { message: "Hello <0>{0}</0>, read the <1>docs</1>." },
  { message: "{count, plural, one {# agent} other {# agents}}" },
]

describe("translation records", () => {
  it("keeps the Lingui ID as the runtime key and names the record with Diglot's hash", () => {
    // Values of `generateMessageId()` from `@lingui/message-utils` 6.12.
    expect(messageId("Deploy your agent")).toBe("oEE8vp")
    expect(messageId("Save", "button")).toBe("z6v0vJ")
    expect(messageSegment("Save", "button")).toEqual({
      hash: hashSkeleton("Save", "button", "plain"),
      skeleton: "Save",
      salt: "button",
      kind: "message",
      format: "plain",
      placeholders: [],
    })
    expect(messageSegment("Save", "button").hash).not.toBe(messageSegment("Save").hash)
    expect(messageSegment("Hello <0>{0}</0>, read the <1>docs</1>.").placeholders).toEqual([{ id: 0, type: "binding", source: "{0}" }])
    const { hash } = messageSegment("Deploy your agent")
    expect(recordPath("es", hash)).toBe(`es/segments/${hash.slice(0, 2)}/${hash}.json`)
  })

  it("writes Diglot records that it reads back, and reports files that are not", async () => {
    const root = await folder()
    const saved = await saveTranslation(root, "es", { message: "Save", context: "button" }, "Guardar", { by: "ana", at: "2026-11-07T10:00:00.000Z" })
    expect(saved.ok).toBe(true)
    const { hash } = messageSegment("Save", "button")
    const file = JSON.parse(await readFile(join(root, recordPath("es", hash)), "utf8")) as unknown
    expect(parseRecord(file)).toEqual({
      hash,
      source: "Save",
      text: "Guardar",
      origin: "human",
      review: "edited",
      derived: "fresh",
      salt: "button",
      by: "ana",
      updatedAt: "2026-11-07T10:00:00.000Z",
    })

    // A record whose source was edited no longer matches its name.
    const other = messageSegment("Other")
    await writeRecord(root, "es", createRecord({ segment: other, text: "Otro", origin: "human" }))
    const otherFile = join(root, recordPath("es", other.hash))
    await writeFile(otherFile, (await readFile(otherFile, "utf8")).replace(`"source": "Other"`, `"source": "Changed"`))
    const broken = messageSegment("Broken")
    await mkdir(dirname(join(root, recordPath("es", broken.hash))), { recursive: true })
    await writeFile(join(root, recordPath("es", broken.hash)), JSON.stringify({ source: "Broken", translation: "Roto" }))
    await writeFile(join(root, "es", "notes.txt"), "not a record")

    const { records, problems } = await readRecords(root, "es")
    expect(Object.keys(records)).toEqual([messageId("Save", "button")])
    expect(records[messageId("Save", "button")]).toMatchObject({ hash, text: "Guardar" })
    expect(problems).toHaveLength(2)
    expect(problems.map(problem => problem.problem)).toEqual(expect.arrayContaining([
      expect.stringContaining("do not match its `hash`"),
      expect.stringContaining("not a Diglot record"),
    ]))
    expect(await readdir(join(root, "es"))).toEqual(["notes.txt", "segments"])
    expect(await readRecords(root, "de")).toEqual({ records: {}, problems: [] })
  })

  it("refuses to save or verify a text that changed since the person read it", async () => {
    const root = await folder()
    const save = { message: "Save", context: "button" }
    const file = join(root, recordPath("es", messageSegment("Save", "button").hash))
    expect((await saveTranslation(root, "es", save, "Guardar", { by: "ana", expected: null })).ok).toBe(true)

    // Luis opened the message before Ana saved it, so he expected no translation.
    const stale = await saveTranslation(root, "es", save, "Salvar", { by: "luis", expected: null })
    expect(stale).toMatchObject({ ok: false, code: "stale" })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ text: "Guardar", by: "ana" })

    expect(await verifyTranslation(root, "es", save, { by: "luis", expected: "Salvar" })).toMatchObject({ ok: false, code: "stale" })
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ review: "edited" })

    const verified = await verifyTranslation(root, "es", save, { by: "luis", expected: "Guardar", at: "2026-11-07T11:00:00.000Z" })
    expect(verified.ok).toBe(true)
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ text: "Guardar", review: "verified", verifiedBy: { by: "luis", at: "2026-11-07T11:00:00.000Z" } })
  })

  it("refuses a translation that loses a placeholder of the message", async () => {
    const root = await folder()
    const result = await saveTranslation(root, "es", messages[2]!, "Hola, lee la <1>documentación</1>.", { by: "ana" })
    expect(result).toMatchObject({ ok: false, code: "invalid", errors: [expect.objectContaining({ code: "missing-placeholder" })] })
    expect((await readRecords(root, "es")).records).toEqual({})
  })

  it.each([
    ["Hello {name}", "Hola", "Hola {name}"],
    ["{count, plural, one {# agent} other {# agents}}", "{total, plural, one {# agente} other {# agentes}}", "{count, plural, one {# agente} other {# agentes}}"],
    ["{role, select, admin {Admin} other {User}}", "{type, select, admin {Admin} other {Usuario}}", "{role, select, admin {Admin} other {Usuario}}"],
    ["{role, select, admin {Admin {name}} other {User {name}}}", "{role, select, admin {Admin} other {Usuario}}", "{role, select, admin {Admin {name}} other {Usuario {name}}}"],
    ["Total: {amount, number}", "Total", "Total: {amount, number}"],
    ["{count, selectordinal, one {#st} other {#th}}", "Primero", "{count, selectordinal, one {#} other {#}}"],
    ["Hello <0>{0}</0>, read the <1>docs</1>.", "Hola <0>{0}</0>, lee la documentación.", "Lee la <1>documentación</1>, <0>{0}</0>."],
    ["Hello <0>{name}</0>", "Hola {name}", "<0>Hola {name}</0>"],
    ["Hello <0>{name}</0>", "Hola <1>{name}</1>", "<0>Hola {name}</0>"],
    ["Hello <0>{name}</0>", "Hola <0>{name}", "<0>Hola {name}</0>"],
    ["Hello <0>{name}</0>", "Hola <0/>{name}", "<0>Hola {name}</0>"],
    ["<0>Hello <1>{name}</1></0>", "<0>Hola <1>{name}</0></1>", "<1><0>Hola {name}</0></1>"],
    ["Hello <0/>{name}", "Hola {name}", "Hola {name}<0/>"],
    ["<0>Open</0> and <0>close</0>", "<0>Abrir</0>", "<0>Cerrar</0> y <0>abrir</0>"],
    ["<0/><0/>", "<0/>", "<0/><0/>"],
    ["<0><0>Open</0></0>", "<0>Abrir</0>", "<0><0>Abrir</0></0>"],
    ["{count, plural, one {<0>open</0> and <0>close</0>} other {<0>open</0> and <0>close</0>}}", "{count, plural, one {<0>abrir</0>} other {<0>abrir</0> y <0>cerrar</0>}}", "{count, plural, one {<0>abrir</0> y <0>cerrar</0>} other {<0>cerrar</0> y <0>abrir</0>}}"],
    ["<0>Open</0>{count, plural, one {<0>close</0>} other {<0>close</0><0/>}}", "<0>Abrir</0>{count, plural, one {cerrar} other {<0>cerrar</0><0/>}}", "{count, plural, one {<0>Cerrar</0>} other {<0>Cerrar</0><0/>}}<0>abrir</0>"],
    ["{count, plural, one {<0>open</0> and <0>close</0>} other {<0>open</0>}}", "{count, plural, one {<0>abrir</0>} other {<0>abrir</0>}}", "{count, plural, one {<0>cerrar</0> y <0>abrir</0>} other {<0>abrir</0>}}"],
    ["{count, plural, one {<0>one agent</0>} other {<0># agents</0>}}", "{count, plural, one {un agente} other {# agentes}}", "{count, plural, one {<0>un agente</0>} other {<0># agentes</0>}}"],
    ["{count, plural, one {<0>one agent</0>} other {<0># agents</0>}}", "{count, plural, one {<0>un agente</0>} other {# agentes}}", "{count, plural, one {<0>un agente</0>} other {<0># agentes</0>}}"],
    ["<0>{count, plural, one {one agent} other {# agents}}</0>", "<0>{count, plural, one {un agente</0>} other {# agentes}}", "<0>{count, plural, one {un agente} other {# agentes}}</0>"],
  ])("keeps every runtime placeholder in %s", async (message, invalid, valid) => {
    const root = await folder()
    const ref = { message }
    expect(await saveTranslation(root, "es", ref, invalid, { by: "ana", expected: null })).toMatchObject({ ok: false, code: "invalid" })
    expect((await readRecords(root, "es")).records).toEqual({})
    expect((await saveTranslation(root, "es", ref, valid, { by: "ana", expected: null })).ok).toBe(true)

    // Records can also be written by Diglot or a text editor. Readers must fall back, and verification must refuse them.
    await writeRecord(root, "es", createRecord({ segment: messageSegment(message), text: invalid, origin: "mt" }))
    expect(await verifyTranslation(root, "es", ref, { by: "luis", expected: invalid })).toMatchObject({ ok: false, code: "invalid" })
    const { records } = await readRecords(root, "es")
    const sources = { [messageId(message)]: { message, hash: messageSegment(message).hash, origins: [] } }
    expect(compileMessages(records, sources)).toEqual(compileMessages({}, sources))
  })

  it("distinguishes quoted ICU text from runtime arguments and rejects invalid ICU", async () => {
    const root = await folder()
    const ref = { message: "Hello '{guest}', {name}" }
    expect((await saveTranslation(root, "es", ref, "Hola '{invitado}', {name}", { by: "ana" })).ok).toBe(true)
    expect(await saveTranslation(root, "es", ref, "Hola {name", { by: "ana" })).toMatchObject({ ok: false, code: "invalid" })
  })

  it("refuses concurrent edits from the same expected text", async () => {
    const root = await folder()
    const ref = { message: "Save", context: "button" }
    const results = await Promise.all([
      saveTranslation(root, "es", ref, "Guardar", { by: "ana", expected: null }),
      saveTranslation(root, "es", ref, "Salvar", { by: "luis", expected: null }),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)).toMatchObject({ code: "stale" })

    const winner = results.find(result => result.ok)!
    if (!winner.ok) throw new Error("No edit succeeded")
    expect((await readRecords(root, "es")).records[messageId(ref.message, ref.context)]).toEqual(winner.record)

    const edits = await Promise.all(["Conservar", "Almacenar"].map(text => saveTranslation(root, "es", ref, text, { by: "ana", expected: winner.record.text })))
    expect(edits.filter(result => result.ok)).toHaveLength(1)
    expect(edits.find(result => !result.ok)).toMatchObject({ code: "stale" })
  })

  it("refuses concurrent edits from separate CLI processes", async () => {
    const root = await folder()
    const ref = { message: "Save", context: "button" }
    const results = await Promise.all(["ana", "luis", "maxi"].map(async (by) => {
      const script = `
        import { saveTranslation } from ${JSON.stringify(new URL("../src/records.ts", import.meta.url).href)};
        const result = await saveTranslation(${JSON.stringify(root)}, "es", ${JSON.stringify(ref)}, ${JSON.stringify(by)}, { by: ${JSON.stringify(by)}, expected: null });
        console.log(JSON.stringify(result));
      `
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script])
      return JSON.parse(stdout) as { ok: boolean, code?: string }
    }))
    expect(results.filter(result => result.ok)).toHaveLength(1)
    const refused = results.filter(result => !result.ok)
    expect(refused).toHaveLength(2)
    for (const result of refused) expect(result).toMatchObject({ ok: false, code: "stale" })
  })

  it("publishes complete records while readers run during edits", async () => {
    const root = await folder()
    const ref = { message: "a".repeat(64_000) }
    const texts = ["a".repeat(8_000), "b".repeat(8_000)]
    expect((await saveTranslation(root, "es", ref, texts[0]!, { by: "ana" })).ok).toBe(true)
    let writing = true
    const edits = (async () => {
      for (let index = 0; index < 6; index++) {
        expect((await saveTranslation(root, "es", ref, texts[(index + 1) % 2]!, { by: "ana", expected: texts[index % 2]! })).ok).toBe(true)
      }
    })().finally(() => { writing = false })
    try {
      do {
        const { records, problems } = await readRecords(root, "es")
        expect(problems).toEqual([])
        expect(Object.keys(records)).toHaveLength(1)
        expect(texts.includes(records[messageId(ref.message)]!.text)).toBe(true)
      } while (writing)
    }
    finally {
      await edits
    }
    expect(await readdir(join(root, "es", "segments", messageSegment(ref.message).hash.slice(0, 2)))).toEqual([`${messageSegment(ref.message).hash}.json`])
  })

  it("writes a folder that `diglot validate` accepts", async () => {
    const root = await folder()
    const translations = ["Despliega tu agente", "Guardar", "Hola <0>{0}</0>, lee la <1>documentación</1>.", "{count, plural, one {# agente} other {# agentes}}"]
    for (const [index, message] of messages.entries()) {
      expect((await saveTranslation(root, "es", message, translations[index]!, { by: "ana", expected: null })).ok).toBe(true)
    }
    expect((await verifyTranslation(root, "es", messages[1]!, { by: "luis", expected: "Guardar" })).ok).toBe(true)

    // Without a manifest, Diglot checks the shape, path, and hash of each record.
    const alone = await diglotValidate(root)
    expect(alone).toMatchObject({ code: 0, checked: 4, errors: [] })

    // With a manifest of the messages, Diglot also checks each text against its message.
    const segments = messages.map(message => messageSegment(message.message, message.context))
    const manifest: Manifest = {
      version: 1,
      source: "app",
      files: {
        "src/App.vue": segments.map(segment => ({
          hash: segment.hash,
          // Diglot 0.2.1 types have no `message` kind. The manifest is JSON, and `diglot validate` accepts it.
          kind: segment.kind as string as SegmentKind,
          format: segment.format,
          skeleton: segment.skeleton,
          words: countWords(segment.skeleton),
          ...(segment.placeholders.length ? { placeholders: segment.placeholders.map(placeholder => placeholder.type) } : {}),
          ...(segment.salt ? { salt: segment.salt } : {}),
        })),
      },
    }
    await writeManifest(join(root, ".diglot"), manifest)
    expect(await diglotValidate(root)).toEqual({ code: 0, checked: 4, errors: [], warnings: [] })

    // A record that loses `{0}`, written without ViteHub, fails the same check.
    await writeRecord(root, "es", createRecord({ segment: segments[2]!, text: "Hola, lee la documentación.", origin: "mt" }))
    const lost = await diglotValidate(root)
    expect(lost.code).toBe(1)
    expect(lost.errors).toEqual([expect.objectContaining({ hash: segments[2]!.hash, message: expect.stringContaining("{0} is missing") })])
  }, 30_000)
})
