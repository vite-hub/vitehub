import { Diagnostic } from "nostics"
import { expect, it } from "vitest"
import { loadDiagnosticCopy } from "../../runtime/test/fixtures/diagnostic-copy.ts"
import { kvResult } from "../src/errors.ts"

it("preserves config throws and allowed operation errors from a separately bundled driver", async () => {
  const copy = await loadDiagnosticCopy(new URL("../", import.meta.url))
  const config = copy.create({ code: "KV_STORE_NOT_FOUND", why: "Unknown store" })
  const invalid = copy.create({ code: "KV_INVALID_LIMIT", why: "Invalid limit" })
  expect(config).not.toBeInstanceOf(Diagnostic)
  await expect(kvResult("list", "missing", async () => { throw config })).rejects.toBe(config)
  await expect(kvResult("list", "default", async () => { throw invalid }, ["KV_INVALID_LIMIT"]))
    .resolves.toEqual([invalid, undefined])
  const [unknown] = await kvResult("list", "default", async () => { throw copy.create({ code: "APP_FAILED", why: "Private" }) })
  expect(unknown?.code).toBe("KV_OPERATION_FAILED")
  expect(JSON.stringify(unknown)).not.toContain("Private")
})
