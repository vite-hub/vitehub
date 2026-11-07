import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { messageId, readRecords, recordFileName, writeRecord } from "../src/records.ts"

describe("translation records", () => {
  it("gives a message the same ID as the build", () => {
    // Values of `generateMessageId()` from `@lingui/message-utils` 6.12.
    expect(messageId("Deploy your agent")).toBe("oEE8vp")
    expect(messageId("Save", "button")).toBe("z6v0vJ")
    expect(messageId("Save", "button")).not.toBe(messageId("Save"))
  })

  it("names files so that IDs that differ only in letter case never share one", () => {
    expect(recordFileName("aB-_09").toLowerCase()).not.toBe(recordFileName("ab-_09").toLowerCase())
    expect(recordFileName("AAAAAA")).toBe("000000000.json")
    expect(recordFileName("______")).toBe("fffffffff.json")
  })

  it("reads back what it writes, and reports records that do not match their file", async () => {
    const root = await mkdtemp(join(tmpdir(), "i18n-records-"))
    try {
      const id = await writeRecord(root, "es", { source: "Save", context: "button", translation: "Guardar", review: "verified" })
      expect(id).toBe(messageId("Save", "button"))
      await writeFile(join(root, "es", recordFileName(messageId("Other"))), JSON.stringify({ source: "Changed", translation: "Cambiado" }))
      await writeFile(join(root, "es", "notes.txt"), "not a record")
      const { records, problems } = await readRecords(root, "es")
      expect(records).toEqual({ [id]: { source: "Save", context: "button", translation: "Guardar", review: "verified" } })
      expect(problems).toEqual([expect.objectContaining({ problem: expect.stringContaining("do not match") })])
      expect(await readdir(join(root, "es"))).toHaveLength(3)
      expect(await readRecords(root, "de")).toEqual({ records: {}, problems: [] })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
