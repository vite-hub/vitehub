import { fileURLToPath } from "node:url"
import { Diagnostic } from "nostics"
import { expect, expectTypeOf, it } from "vitest"
import { defineErrors, isRuntimeDiagnostic } from "@vite-hub/runtime"
import { loadBundledCopy, loadDiagnosticCopy } from "../../runtime/test/fixtures/diagnostic-copy.ts"
import { kvResult } from "../src/errors.ts"

it.each([
  { origin: "local", frozen: false },
  { origin: "foreign", frozen: false },
  { origin: "local", frozen: true },
  { origin: "foreign", frozen: true },
])("serializes allowed $origin native diagnostics with frozen=$frozen without exposing their metadata", async ({ origin, frozen }) => {
  const init = {
    code: "KV_INVALID_CURSOR",
    why: "The cursor is invalid.",
    fix: "Start a new list.",
    docs: "https://vitehub.dev/docs/kv/limits-and-errors#kv_invalid_cursor",
    cause: new Error("private provider token"),
    data: { token: "private metadata" },
    sources: ["private/provider.ts:42"],
  }
  const failure = origin === "local"
    ? new Diagnostic(init)
    : (await loadDiagnosticCopy(new URL("../", import.meta.url))).create(init)
  if (!isRuntimeDiagnostic(failure)) throw new Error("Expected a native diagnostic")
  expect(failure instanceof Diagnostic).toBe(origin === "local")
  Object.defineProperty(failure, "name", { value: "ProviderError" })
  const stack = failure.stack
  if (frozen) Object.freeze(failure)
  const [error, value] = await kvResult("list", "default", async () => { throw failure }, ["KV_INVALID_CURSOR"])
  if (frozen) {
    expect(error).not.toBe(failure)
    expect(failure.name).toBe("ProviderError")
  }
  else expect(error).toBe(failure)
  expect(value).toBeUndefined()
  if (!error) throw new Error("Expected the cursor error")
  expectTypeOf(error.code).toEqualTypeOf<"KV_INVALID_CURSOR" | "KV_OPERATION_FAILED">()
  expectTypeOf(error.name).toEqualTypeOf<"KV_INVALID_CURSOR" | "KV_OPERATION_FAILED">()
  expect(error.name).toBe(init.code)
  expect(error).toMatchObject(init)
  expect(error.cause).toBe(init.cause)
  expect(error.data).toBe(init.data)
  expect(error.stack).toBe(stack)
  const publicError = {
    code: init.code,
    name: init.code,
    why: init.why,
    fix: init.fix,
    docs: init.docs,
  }
  expect(error.toJSON()).toEqual(publicError)
  expect(JSON.parse(JSON.stringify({ error }))).toEqual({ error: publicError })
})

it("preserves config throws and allowed operation errors from a separately bundled driver", async () => {
  const copy = await loadDiagnosticCopy(new URL("../", import.meta.url))
  const config = copy.create({ code: "KV_STORE_NOT_FOUND", why: "Unknown store" })
  const invalid = copy.create({ code: "KV_INVALID_LIMIT", why: "Invalid limit" })
  if (!isRuntimeDiagnostic(config)) throw new Error("Expected a config diagnostic")
  const serializeConfig = config.toJSON
  expect(config).not.toBeInstanceOf(Diagnostic)
  await expect(kvResult("list", "missing", async () => { throw config })).rejects.toBe(config)
  expect(config.toJSON).toBe(serializeConfig)
  await expect(kvResult("list", "default", async () => { throw invalid }, ["KV_INVALID_LIMIT"]))
    .resolves.toEqual([invalid, undefined])
  const [unknown] = await kvResult("list", "default", async () => { throw copy.create({ code: "APP_FAILED", why: "Private" }) })
  expect(unknown?.code).toBe("KV_OPERATION_FAILED")
  expect(JSON.stringify(unknown)).not.toContain("Private")
})

it("preserves separately bundled defineErrors results and their metadata", async () => {
  const source = `export { defineErrors } from ${JSON.stringify(fileURLToPath(new URL("../../runtime/src/result.ts", import.meta.url)))}`
  // SAFETY: The fixture re-exports this exact Runtime catalog factory from a separate bundle.
  const copy = await loadBundledCopy(new URL("../", import.meta.url), source) as { defineErrors: typeof defineErrors }
  const data = { token: "private catalog metadata" }
  const cause = new Error("private catalog cause")
  const sources = ["private/catalog.ts:10"]
  const failure = copy.defineErrors({
    docs: "https://vitehub.dev/docs/kv/limits-and-errors",
    codes: { KV_INVALID_CURSOR: { why: "Invalid cursor.", fix: "Start again.", data } },
  }).KV_INVALID_CURSOR({ cause, sources })
  const publicError = failure.toJSON()
  const stack = failure.stack
  expect(failure).not.toBeInstanceOf(Diagnostic)

  const [error] = await kvResult("list", "default", async () => { throw failure }, ["KV_INVALID_CURSOR"])
  expect(error).toBe(failure)
  expect(error?.data).toBe(data)
  expect(error?.cause).toBe(cause)
  expect(error?.sources).toBe(sources)
  expect(error?.stack).toBe(stack)
  expect(error?.toJSON()).toEqual(publicError)
  expect(JSON.stringify(error)).not.toContain("private")
})

it("wraps disallowed diagnostics and serialized lookalikes without exposing private fields", async () => {
  const failure = new Diagnostic({ code: "KV_INVALID_CURSOR", why: "Private cursor", data: { token: "private" } })
  const serialize = failure.toJSON
  const [disallowed] = await kvResult("list", "default", async () => { throw failure }, ["KV_INVALID_LIMIT"])
  const [serialized] = await kvResult("list", "default", async () => { throw { ...failure } }, ["KV_INVALID_CURSOR"])
  const [application] = await kvResult("list", "default", async () => { throw Object.assign(new Error("Private cursor"), { code: "KV_INVALID_CURSOR" }) }, ["KV_INVALID_CURSOR"])
  for (const error of [disallowed, serialized, application]) {
    expect(error?.code).toBe("KV_OPERATION_FAILED")
    expect(JSON.stringify(error)).not.toContain("private")
    expect(JSON.stringify(error)).not.toContain("Private")
  }
  expect(disallowed?.cause).toBe(failure)
  expect(failure.toJSON).toBe(serialize)
})
