import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveSandboxTaskProject } from "../../src/task/project.ts"
import { createEntrySource, EXEC_STDIO_OUTPUT_MARKER, MAX_EXEC_DIAGNOSTIC_BYTES } from "../../src/task/runtime/entry-script.injected.ts"
import { readExecOutputWithRecovery } from "../../src/task/runtime/output-recovery.ts"
import {
  decodeSandboxTaskValue,
  DEFAULT_SANDBOX_TASK_TRANSFER_BYTES,
  DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS,
  encodeSandboxTaskValue,
  SANDBOX_VALUE_MARKER,
} from "../../src/task/runtime/binary-sidecars.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function executePackageEntry(definitionSource: string, options: {
  execution?: 'definition' | 'module'
  input?: unknown
  inputFiles?: Record<number, Uint8Array>
  inputJson?: string
  prelude?: string
  transfer?: Partial<NonNullable<Parameters<typeof createEntrySource>[3]>>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-task-package-entry-"))
  tempDirs.push(root)
  const definitionPath = join(root, "definition.mjs")
  const entryPath = join(root, "entry.mjs")
  const inputPath = join(root, "input.json")
  const outputPath = join(root, "output.json")
  await Promise.all([
    writeFile(definitionPath, definitionSource, "utf8"),
    writeFile(entryPath, (options.prelude ?? "") + createEntrySource(definitionPath, options.execution ?? "module", undefined, {
      ...DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS,
      maxOutputBytes: DEFAULT_SANDBOX_TASK_TRANSFER_BYTES,
      ...options.transfer,
    }), "utf8"),
    writeFile(inputPath, options.inputJson ?? JSON.stringify(options.input ?? { context: {}, payload: {} }), "utf8"),
  ])
  if (options.inputFiles) {
    const assetsDir = `${inputPath}.files`
    await mkdir(assetsDir, { recursive: true })
    await Promise.all(Object.entries(options.inputFiles).map(async ([id, bytes]) => {
      await writeFile(join(assetsDir, id), bytes)
    }))
  }

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, inputPath, outputPath], { stdio: "ignore" })
    child.once("error", reject)
    child.once("close", resolve)
  })
  const raw = await readFile(outputPath, "utf8")
  const output = JSON.parse(raw) as {
    error?: { code?: string; message?: string }
    ok: boolean
    result?: unknown
  }
  return {
    code,
    output,
    raw,
    outputPath,
    readOutputFile: async (id: number) => await readFile(join(`${outputPath}.files`, String(id))),
  }
}

describe("package entry result transport", () => {
  it.each(['definition', 'module'] as const)("defaults omitted context for a %s handler", async (execution) => {
    const handler = "(payload, context) => ({ keys: Object.keys(context), omittedPayload: payload === undefined })"
    const definition = execution === 'module' ? handler : `{ handler: ${handler} }`
    const result = await executePackageEntry(`export default ${definition}`, { execution, input: {} })

    expect(result.code).toBe(0)
    expect(result.output).toEqual({ ok: true, result: { keys: [], omittedPayload: true } })
  })

  it.each(['definition', 'module'] as const)("preserves supplied context for a %s handler", async (execution) => {
    const handler = "(_payload, context) => context.requestId"
    const definition = execution === 'module' ? handler : `{ handler: ${handler} }`
    const result = await executePackageEntry(`export default ${definition}`, {
      execution,
      input: { context: { requestId: 'request-42' } },
    })

    expect(result.code).toBe(0)
    expect(result.output).toEqual({ ok: true, result: 'request-42' })
  })

  it.each([
    ["binary", "new Response(new Uint8Array([0, 127, 255]), { status: 201 })", [0, 127, 255]],
    ["streaming", "new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0, 127])); controller.enqueue(new Uint8Array([255])); controller.close() } }), { status: 201 })", [0, 127, 255]],
    ["null", "new Response(null, { status: 204 })", []],
  ])("recognizes a native %s response without cloning it", async (_label, expression, bytes) => {
    const execution = await executePackageEntry(`export default () => ${expression}`, {
      prelude: [
        "const proofNativeClone = Response.prototype.clone",
        "let proofCloneCount = 0",
        "Response.prototype.clone = function (...args) {",
        "  this.headers.set('x-clone-count', String(++proofCloneCount))",
        "  return Reflect.apply(proofNativeClone, this, args)",
        "}",
        "",
      ].join("\n"),
    })

    expect(execution.code).toBe(0)
    const sandbox = {} as Parameters<typeof decodeSandboxTaskValue>[0]
    const response = await decodeSandboxTaskValue(sandbox, execution.output.result, "", "result")
    if (!(response instanceof Response)) throw new TypeError("Expected Response")
    expect(response.headers.get("x-clone-count")).toBeNull()
    expect(response.status).toBe(bytes.length ? 201 : 204)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes))
  })

  it("preserves a Response from another realm across the child process", async () => {
    const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url))
    const undiciDirectory = (await readdir(join(workspaceRoot, "node_modules/.pnpm"))).find(name => name.startsWith("undici@"))
    if (!undiciDirectory) throw new Error("undici package not found")
    const foreignResponseModule = pathToFileURL(join(workspaceRoot, "node_modules/.pnpm", undiciDirectory, "node_modules/undici/index.js")).href
    const execution = await executePackageEntry([
      `import { Response as ForeignResponse } from ${JSON.stringify(foreignResponseModule)}`,
      `export default () => new ForeignResponse(new Uint8Array([0, 127, 255]), { status: 201, statusText: 'Created', headers: { 'x-result': 'preserved' } })`,
    ].join("\n"))

    expect(execution.code).toBe(0)
    const sandbox = {} as Parameters<typeof decodeSandboxTaskValue>[0]
    const response = await decodeSandboxTaskValue(sandbox, execution.output.result, "", "result")

    expect(response).toBeInstanceOf(Response)
    if (!(response instanceof Response)) throw new TypeError("Expected Response")
    expect(response.status).toBe(201)
    expect(response.statusText).toBe("Created")
    expect(response.headers.get("x-result")).toBe("preserved")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 127, 255]))
  })

  it("preserves response-shaped objects with only an enumerable symbol", async () => {
    const execution = await executePackageEntry([
      `export default () => {`,
      `  const headers = {}`,
      `  Object.defineProperties(headers, { get: { value: () => 'preserved' }, [Symbol.iterator]: { value: function* () {} } })`,
      `  const prototype = { clone() { return this }, get body() { return null } }`,
      `  const value = Object.assign(Object.create(prototype), { status: 201, statusText: 'Created', headers })`,
      `  return Object.defineProperties(value, { [Symbol('state')]: { value: 'preserved', enumerable: true }, arrayBuffer: { value: async () => new ArrayBuffer() } })`,
      `}`,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output.result).toMatchObject({ status: 201, statusText: "Created" })
    expect(execution.output.result).not.toHaveProperty(SANDBOX_VALUE_MARKER)
  })

  it("rejects non-enumerable spoofs with a structurally valid clone result", async () => {
    const execution = await executePackageEntry([
      `export default () => {`,
      `  const headers = {}`,
      `  Object.defineProperties(headers, { get: { value: () => 'preserved' }, [Symbol.iterator]: { value: function* () {} } })`,
      `  const prototype = {}`,
      `  Object.defineProperties(prototype, { clone: { value() { return { status: 201, statusText: 'Created', headers, arrayBuffer: async () => new ArrayBuffer(), [Symbol.toStringTag]: 'Response' } } }, body: { get() { return null } } })`,
      `  const value = Object.assign(Object.create(prototype), { status: 201, statusText: 'Created', headers })`,
      `  return Object.defineProperty(value, 'arrayBuffer', { value: async () => new ArrayBuffer() })`,
      `}`,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output.result).toMatchObject({ status: 201, statusText: "Created" })
    expect(execution.output.result).not.toHaveProperty(SANDBOX_VALUE_MARKER)
  })

  it("rejects spoofs with an own forged constructor", async () => {
    const execution = await executePackageEntry([
      `export default () => {`,
      `  const headers = {}`,
      `  Object.defineProperties(headers, { get: { value: () => 'preserved' }, [Symbol.iterator]: { value: function* () {} } })`,
      `  const prototype = {}`,
      `  Object.defineProperties(prototype, { clone: { value() { return Object.create(prototype) } }, body: { get() { return null } } })`,
      `  const constructor = function Response() {}`,
      `  constructor.prototype = prototype`,
      `  const value = Object.assign(Object.create(prototype), { status: 201, statusText: 'Created', headers })`,
      `  Object.defineProperties(value, { arrayBuffer: { value: async () => new ArrayBuffer() }, constructor: { value, enumerable: false } })`,
      `  return value`,
      `}`,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output.result).toMatchObject({ status: 201, statusText: "Created" })
    expect(execution.output.result).not.toHaveProperty(SANDBOX_VALUE_MARKER)
  })

  it("preserves objects with an inherited forged constructor", async () => {
    const execution = await executePackageEntry([
      `export default () => {`,
      `  const headers = {}`,
      `  Object.defineProperties(headers, { get: { value: () => 'preserved' }, [Symbol.iterator]: { value: function* () {} } })`,
      `  const prototype = {}`,
      `  const constructor = function Response() {}`,
      `  constructor.prototype = prototype`,
      `  Object.defineProperties(prototype, { constructor: { value: constructor }, clone: { value() { return Object.create(prototype) } }, body: { get() { return null } } })`,
      `  const value = Object.assign(Object.create(prototype), { status: 201, statusText: 'Created', headers, requestId: 'kept' })`,
      `  return Object.defineProperty(value, 'arrayBuffer', { value: async () => new ArrayBuffer() })`,
      `}`,
    ].join("\n"))
    expect(execution.code).toBe(0)
    expect(execution.output.result).toMatchObject({ requestId: "kept" })
  })

  it("preserves objects forged with a Response class constructor", async () => {
    const execution = await executePackageEntry([
      `export default () => {`,
      `  const headers = {}`,
      `  Object.defineProperties(headers, { get: { value: () => 'preserved' }, [Symbol.iterator]: { value: function* () {} } })`,
      `  class Response { static error() {}; static json() {}; static redirect() {}; clone() { return Object.create(Response.prototype) }; get body() { return null } }`,
      `  const value = Object.assign(Object.create(Response.prototype), { status: 201, statusText: 'Created', headers, requestId: 'kept' })`,
      `  return Object.defineProperty(value, 'arrayBuffer', { value: async () => new ArrayBuffer() })`,
      `}`,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output.result).toMatchObject({ requestId: "kept" })
  })

  it("preserves ordinary objects with non-enumerable response-like prototype members", async () => {
    const execution = await executePackageEntry([
      `export default () => {`,
      `  const headers = {}`,
      `  Object.defineProperties(headers, { get: { value: () => 'preserved' }, [Symbol.iterator]: { value: function* () {} } })`,
      `  const prototype = {}`,
      `  Object.defineProperties(prototype, { clone: { value() { return {} } }, body: { get() { return null } } })`,
      `  const value = Object.assign(Object.create(prototype), { status: 201, statusText: 'Created', headers, extra: 'kept' })`,
      `  return Object.defineProperty(value, 'arrayBuffer', { value: async () => new ArrayBuffer() })`,
      `}`,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output.result).toMatchObject({ status: 201, statusText: "Created", extra: "kept" })
  })

  it("preserves response-shaped ordinary objects", async () => {
    const execution = await executePackageEntry([
      `export default () => {`,
      `  const headers = {}`,
      `  Object.defineProperties(headers, { get: { value: () => 'preserved' }, [Symbol.iterator]: { value: function* () {} } })`,
      `  const prototype = { clone() { return this }, get body() { return null } }`,
      `  const value = Object.assign(Object.create(prototype), { status: 201, statusText: 'Created', headers, extra: 'kept' })`,
      `  return Object.defineProperties(value, { [Symbol.toStringTag]: { value: 'Response' }, [Symbol('spoofed')]: { value: 'preserved', enumerable: true }, arrayBuffer: { value: async () => new ArrayBuffer() } })`,
      `}`,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output.result).toMatchObject({ status: 201, statusText: "Created", extra: "kept" })
  })

  it.each([
    ["subclass tag", "new (class extends Uint8Array { get [Symbol.toStringTag]() { return 'Bytes' } })([0, 1, 2, 3, 4]).subarray(1, 4)"],
    ["own tag", "Object.defineProperty(new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4), Symbol.toStringTag, { value: 'Bytes' })"],
    ["throwing tag", "Object.defineProperty(new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4), Symbol.toStringTag, { get() { throw new Error('tag read') } })"],
  ])("extracts foreign byte arrays with a %s", async (_label, expression) => {
    const execution = await executePackageEntry([
      "import { runInNewContext } from 'node:vm'",
      `export default () => runInNewContext(${JSON.stringify(expression)})`,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({
      ok: true,
      result: { [SANDBOX_VALUE_MARKER]: { id: 0, kind: "uint8array", tag: "binary" } },
    })
    expect(Array.from(await execution.readOutputFile(0))).toEqual([1, 2, 3])
  })

  it("does not extract another typed array with a Uint8Array tag as a byte sidecar", async () => {
    const execution = await executePackageEntry([
      "import { runInNewContext } from 'node:vm'",
      `export default () => runInNewContext("Object.defineProperty(new Uint16Array([1, 2, 3]), Symbol.toStringTag, { value: 'Uint8Array' })")`,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({ ok: true, result: { 0: 1, 1: 2, 2: 3 } })
  })

  it.each(["opaque", "opaqueredirect"])("preserves a %s response across the child process", async (type) => {
    const url = type === "opaqueredirect" ? "https://example.com/manual-redirect" : ""
    const execution = await executePackageEntry(
      `export default () => Object.defineProperties(Response.error(), { type: { value: '${type}' }, url: { value: '${url}' } })`,
    )
    expect(execution.code).toBe(0)
    const sandbox = {} as Parameters<typeof decodeSandboxTaskValue>[0]
    const response = await decodeSandboxTaskValue(sandbox, execution.output.result, "", "result")
    expect(response).toBeInstanceOf(Response)
    if (!(response instanceof Response)) throw new TypeError("Expected Response")
    expect(response.type).toBe(type)
    expect(response.url).toBe(url)
    expect(response.clone().url).toBe(url)
    expect(response.clone().type).toBe(type)
    expect(response.status).toBe(0)
    expect(response.body).toBeNull()
    expect(await response.text()).toBe("")
  })

  it.each([201, 422, 204, 205, 304])("preserves a handler Response with status %s across the child process", async (status) => {
    const empty = [204, 205, 304].includes(status)
    const execution = await executePackageEntry(
      `export default () => new Response(${empty ? 'null' : 'new Uint8Array([0, 127, 255])'}, { status: ${status}, statusText: 'Custom', headers: { 'x-result': 'preserved' } })`,
    )
    expect(execution.code).toBe(0)
    const sandbox = {} as Parameters<typeof decodeSandboxTaskValue>[0]
    const response = await decodeSandboxTaskValue(sandbox, execution.output.result, '', 'result')
    expect(response).toBeInstanceOf(Response)
    if (!(response instanceof Response)) throw new TypeError('Expected Response')
    expect(response.status).toBe(status)
    expect(response.statusText).toBe('Custom')
    expect(response.headers.get('x-result')).toBe('preserved')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(empty ? [] : [0, 127, 255]))
  })

  it.each(["Response.error()", "new Response(null)", "new Response(new Uint8Array())"])("preserves %s across the child process", async (expression) => {
    const execution = await executePackageEntry(`export default () => ${expression}`)
    expect(execution.code).toBe(0)
    const sandbox = {} as Parameters<typeof decodeSandboxTaskValue>[0]
    const response = await decodeSandboxTaskValue(sandbox, execution.output.result, "", "result")
    if (!(response instanceof Response)) throw new TypeError("Expected Response")
    expect(response.type).toBe(expression === "Response.error()" ? "error" : "default")
    expect(response.status).toBe(expression === "Response.error()" ? 0 : 200)
    expect(response.body === null).toBe(expression !== "new Response(new Uint8Array())")
    expect(await response.text()).toBe("")
  })

  it("calls the default function with payload and context", async () => {
    const execution = await executePackageEntry(
      "export default async function (payload, context) { return { payload, context } }\n",
      { input: { context: { requestId: "request-1" }, payload: { value: "ready" } } },
    )

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({
      ok: true,
      result: {
        context: { requestId: "request-1" },
        payload: { value: "ready" },
      },
    })
  })

  it("stages binary fields returned in a class with a run method", async () => {
    const execution = await executePackageEntry([
      `class Result {`,
      `  constructor() { this.bytes = new Uint8Array([1, 2, 3]) }`,
      `  run() { return 'application method' }`,
      `}`,
      `export default async function () { return new Result() }`,
      ``,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output).toMatchObject({
      ok: true,
      result: { bytes: { [SANDBOX_VALUE_MARKER]: { kind: "uint8array", tag: "binary" } } },
    })
    expect(Uint8Array.from(await execution.readOutputFile(0))).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it("does not treat a spoofed typed-array tag as a byte array", async () => {
    const execution = await executePackageEntry([
      `export default async function () {`,
      `  const value = new Uint16Array([513])`,
      `  Object.defineProperty(value, Symbol.toStringTag, { value: 'Uint8Array' })`,
      `  return value`,
      `}`,
      ``,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({ ok: true, result: { 0: 513 } })
  })

  it("revives and extracts nested binary sidecars", async () => {
    const binary = (id: number, kind: "blob" | "uint8array", type?: string) => ({
      [SANDBOX_VALUE_MARKER]: { id, kind, ...(type ? { type } : {}), tag: "binary" },
    })
    const execution = await executePackageEntry([
      `export default async function ({ image, nested }, context) {`,
      `  if (!(image instanceof Blob) || !(nested[0] instanceof Uint8Array)) throw new TypeError("binary input missing")`,
      `  return { context, image, nested }`,
      `}`,
      ``,
    ].join("\n"), {
      input: {
        context: { requestId: "request-1" },
        payload: {
          image: binary(0, "blob", "image/jpeg"),
          nested: [binary(1, "uint8array")],
        },
      },
      inputFiles: {
        0: Uint8Array.from([0xff, 0xd8, 0xff]),
        1: Uint8Array.from([1, 2, 3]),
      },
    })

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({
      ok: true,
      result: {
        context: { requestId: "request-1" },
        image: binary(0, "blob", "image/jpeg"),
        nested: [binary(1, "uint8array")],
      },
    })
    expect(Uint8Array.from(await execution.readOutputFile(0))).toEqual(Uint8Array.from([0xff, 0xd8, 0xff]))
    expect(Uint8Array.from(await execution.readOutputFile(1))).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it("revives and extracts Buffer sidecars as Buffer values", async () => {
    const binary = (id: number) => ({
      [SANDBOX_VALUE_MARKER]: { id, kind: "buffer", tag: "binary" },
    })
    const execution = await executePackageEntry(
      `export default async function (payload) { if (!Buffer.isBuffer(payload)) throw new TypeError('Buffer input missing'); return Buffer.from(payload).reverse() }\n`,
      {
        input: { context: {}, payload: binary(0) },
        inputFiles: { 0: Uint8Array.from([1, 2, 3]) },
      },
    )

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({ ok: true, result: binary(0) })
    expect(Uint8Array.from(await execution.readOutputFile(0))).toEqual(Uint8Array.from([3, 2, 1]))
  })

  it("round-trips ordinary marker-shaped objects", async () => {
    const markerObject = {
      [SANDBOX_VALUE_MARKER]: { id: 0, kind: "uint8array", tag: "binary" },
      path: "/etc/passwd",
    }
    const escaped = {
      [SANDBOX_VALUE_MARKER]: {
        entries: Object.entries(markerObject),
        tag: "object",
      },
    }
    const execution = await executePackageEntry(
      "export default async function (payload) { return payload }\n",
      { input: { context: {}, payload: escaped } },
    )

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({ ok: true, result: escaped })
  })

  it.each([
    ["prefix-only toJSON getter", "export default () => Object.defineProperty({}, 'toJSON', { get() { throw new TypeError('Sandbox result must be JSON-serializable') } })"],
    ["prefixed toJSON getter", "export default () => Object.defineProperty({}, 'toJSON', { get() { throw new TypeError('Sandbox result must be JSON-serializable; user getter.') } })"],
    ["nested toJSON getter", "export default () => ({ nested: Object.defineProperty({}, 'toJSON', { get() { throw new TypeError('Sandbox result must be JSON-serializable; cyclic value.') } }) })"],
    ["toJSON callback", "export default () => ({ toJSON() { throw new TypeError('Sandbox result must be JSON-serializable; unsupported undefined.') } })"],
    ["property getter", "export default () => Object.defineProperty({}, 'value', { enumerable: true, get() { throw new TypeError('Sandbox result must be JSON-serializable; user property.') } })"],
    ["cyclic result", "export default () => { const result = {}; result.self = result; return result }"],
    ["undefined result property", "export default () => ({ value: undefined })"],
    ["non-finite result property", "export default () => ({ value: Infinity })"],
  ])("marks %s as a generated serialization error", async (_label, source) => {
    const execution = await executePackageEntry(source)

    expect(execution.code).toBe(1)
    expect(execution.output).toMatchObject({
      error: { code: "SANDBOX_TASK_SERIALIZATION_ERROR", message: expect.stringContaining("Sandbox result must be JSON-serializable") },
      ok: false,
    })
  })

  it("preserves a handler error even when its message matches a serialization diagnostic", async () => {
    const execution = await executePackageEntry(
      "export default () => { throw new TypeError('Sandbox result must be JSON-serializable; handler failure.') }",
    )

    expect(execution.code).toBe(1)
    expect(execution.output).toMatchObject({
      error: { message: "Sandbox result must be JSON-serializable; handler failure." },
      ok: false,
    })
    expect(execution.output.error?.code).toBeUndefined()
  })

  it("applies result toJSON before staging nested binary values", async () => {
    const execution = await executePackageEntry([
      `export default async function () {`,
      `  return {`,
      `    bytes: new Uint8Array([1, 2, 3]),`,
      `    toJSON() { return { length: this.bytes.byteLength } },`,
      `  }`,
      `}`,
      ``,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({ ok: true, result: { length: 3 } })
  })

  it("serializes valid and invalid dates in task results", async () => {
    const execution = await executePackageEntry(
      `export default () => ({ valid: new Date(0), invalid: new Date(NaN) })`,
    )

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({ ok: true, result: { valid: "1970-01-01T00:00:00.000Z", invalid: null } })
  })

  it("applies result toJSON only once with the JSON property key", async () => {
    const execution = await executePackageEntry([
      `let calls = 0`,
      `export default async function () {`,
      `  return [{`,
      `    bytes: new Uint8Array([1, 2, 3]),`,
      `    toJSON(key) {`,
      `      if (key !== '0' || ++calls > 1) throw new TypeError('invalid toJSON call')`,
      `      return this`,
      `    },`,
      `  }]`,
      `}`,
      ``,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output).toMatchObject({
      ok: true,
      result: [{ bytes: { [SANDBOX_VALUE_MARKER]: { kind: "uint8array", tag: "binary" } } }],
    })
  })

  it("counts result toJSON replacements toward maxDepth", async () => {
    const execution = await executePackageEntry([
      `export default async function () {`,
      `  return { toJSON() { return { nested: true } } }`,
      `}`,
      ``,
    ].join("\n"), { transfer: { maxDepth: 0 } })

    expect(execution.code).not.toBe(0)
    expect(execution.output.error?.code).toBe("SANDBOX_TASK_TRANSFER_LIMIT")
    expect(execution.output.error?.message).toContain("maxDepth")
  })

  it("accepts primitive result toJSON replacements at maxDepth zero", async () => {
    const execution = await executePackageEntry([
      `export default async function () {`,
      `  return { toJSON() { return 1 } }`,
      `}`,
      ``,
    ].join("\n"), { transfer: { maxDepth: 0 } })

    expect(execution.code).toBe(0)
    expect(execution.output).toMatchObject({ ok: true, result: 1 })
  })

  it("applies array result toJSON before walking its elements", async () => {
    const execution = await executePackageEntry([
      `class Values extends Array {`,
      `  toJSON() { return { length: this.length } }`,
      `}`,
      `export default async function () { return new Values(new Uint8Array([1, 2, 3])) }`,
      ``,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({ ok: true, result: { length: 1 } })
  })

  it("preserves boxed primitive result semantics", async () => {
    const execution = await executePackageEntry(
      `export default async function () { const number = new Number(5); number.valueOf = () => 2; return { boolean: new Boolean(true), number, string: new String('ready') } }\n`,
    )

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({
      ok: true,
      result: { boolean: true, number: 2, string: "ready" },
    })
  })

  it("classifies throwing boxed primitive valueOf methods as serialization errors", async () => {
    const execution = await executePackageEntry(
      `export default async function () { const number = new Number(5); number.valueOf = () => { throw new Error('broken valueOf') }; return number }\n`,
    )

    expect(execution.code).toBe(1)
    expect(execution.output).toMatchObject({
      error: { code: "SANDBOX_TASK_SERIALIZATION_ERROR", cause: "Error: broken valueOf" },
      ok: false,
    })
  })

  it("preserves boxed primitive results created in another realm", async () => {
    const execution = await executePackageEntry([
      `import { runInNewContext } from 'node:vm'`,
      `export default async function () { return {`,
      `  boolean: runInNewContext('new Boolean(true)'),`,
      `  number: runInNewContext('new Number(5)'),`,
      `  string: runInNewContext("new String('ready')"),`,
      `} }`,
      ``,
    ].join("\n"))

    expect(execution.code).toBe(0)
    expect(execution.output).toEqual({
      ok: true,
      result: { boolean: true, number: 5, string: "ready" },
    })
  })

  it.each([
    ["path-like", `"../../etc/passwd"`],
    ["negative-zero", "-0"],
  ])("rejects %s input sidecar identifiers", async (_label, id) => {
    const execution = await executePackageEntry(
      "export default async function () { return { ok: true } }\n",
      {
        inputJson: `{"context":{},"payload":{"${SANDBOX_VALUE_MARKER}":{"id":${id},"kind":"uint8array","tag":"binary"}}}`,
      },
    )

    expect(execution.code).toBe(1)
    expect(execution.output).toMatchObject({
      error: { message: "Sandbox input contains an invalid binary sidecar descriptor." },
      ok: false,
    })
  })

  it.each([
    ["object default export", "export default { run() {} }\n", "must default-export a function"],
    ["missing default export", "export const value = true\n", "must default-export a function"],
    ["symbol default export", "export default Symbol('result')\n", "must default-export a function"],
    ["nested undefined", "export default () => ({ value: undefined })\n", "unsupported undefined"],
    ["boxed bigint", "export default () => Object(1n)\n", "unsupported bigint"],
    ["bigint result", "export default () => 1n\n", "unsupported bigint"],
    [
      "cyclic result",
      "export default () => { const value = {}; value.self = value; return value }\n",
      "must be JSON-serializable",
    ],
  ])("rejects %s", async (_label, source, message) => {
    const execution = await executePackageEntry(source)

    expect(execution.code).toBe(1)
    expect(execution.output).toMatchObject({
      error: { message: expect.stringContaining(message) },
      ok: false,
    })
  })
})

describe("output transfer limits", () => {
  it("uses package manifest overrides for executable entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-task-transfer-"))
    tempDirs.push(root)
    const entry = join(root, "index.mjs")
    const definition = "export default () => Array.from({ length: 65 }, () => new Uint8Array([1]))"
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      vitehub: { sandboxTask: { transfer: { maxSidecars: 65 } } },
    }))
    await writeFile(entry, definition)

    const project = await resolveSandboxTaskProject(entry, root, { readSandboxTaskOptions: true })
    expect(project.options).toEqual({ transfer: { maxSidecars: 65 } })
    const execution = await executePackageEntry(definition, { transfer: project.options?.transfer })
    expect(execution.output).toMatchObject({ ok: true })
    expect(execution.output.result).toHaveLength(65)
    expect(await execution.readOutputFile(64)).toEqual(Buffer.from([1]))
  })

  it.each(["{ nested: true }", "{ toJSON() { return { nested: true } } }"])("accepts one level of result nesting: %s", async (value) => {
    const execution = await executePackageEntry(`export default () => (${value})`, { transfer: { maxDepth: 1 } })
    expect(execution.output).toEqual({ ok: true, result: { nested: true } })
  })

  it("transports a native File as a Blob", async () => {
    const execution = await executePackageEntry('export default () => new File(["abc"], "upload.txt", { type: "text/plain" })', {
      transfer: { maxSidecarBytes: 3 },
    })
    expect(execution.output).toEqual({
      ok: true,
      result: { [SANDBOX_VALUE_MARKER]: { id: 0, kind: "blob", tag: "binary", type: "text/plain" } },
    })
    expect(await execution.readOutputFile(0)).toEqual(Buffer.from("abc"))
  })

  it.each([
    ['() => { throw new Error("conversion failed") }', { message: "conversion failed" }],
    ['() => new Uint8Array(4)', { code: "SANDBOX_TASK_TRANSFER_LIMIT", message: "Sandbox result exceeds its maxSidecarBytes limit (4 > 3)." }],
    ['() => "x".repeat(64)', { code: "SANDBOX_TASK_TRANSFER_LIMIT", message: "Sandbox result exceeds its maxOutputBytes limit (87 > 32)." }],
  ])("preserves generated failures under a small output limit: %s", async (handler, error) => {
    const execution = await executePackageEntry(`export default ${handler}`, { transfer: { maxOutputBytes: 32, maxSidecarBytes: 3 } })
    const sandbox = { provider: "vercel", readFile: (path: string) => readFile(path, "utf8") } as Parameters<typeof readExecOutputWithRecovery>[0]
    const direct = await readExecOutputWithRecovery(sandbox, execution.outputPath, undefined, undefined, undefined, 32)
    expect(JSON.parse(direct)).toMatchObject({ ok: false, error })
    const marker = await readExecOutputWithRecovery(sandbox, execution.outputPath, undefined, undefined, {
      stderr: EXEC_STDIO_OUTPUT_MARKER + execution.raw,
    }, 32)
    expect(marker).toBe(direct)
  })

  it("bounds oversized diagnostics even when the message needs JSON escapes", async () => {
    const execution = await executePackageEntry('export default () => { throw new Error("failure: " + "\\u0000".repeat(200_000)) }', {
      transfer: { maxOutputBytes: 32 },
    })
    expect(execution.output.error?.message).toMatch(/^failure: /)
    expect(Buffer.byteLength(execution.raw)).toBeLessThanOrEqual(MAX_EXEC_DIAGNOSTIC_BYTES)
  })

  it("cancels a Response stream before consuming its full body", async () => {
    const execution = await executePackageEntry(`
      import { writeFileSync } from 'node:fs'
      export default () => {
        let pulls = 0
        return new Response(new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024))
            if (++pulls === 128) controller.close()
          },
          cancel() { writeFileSync(process.argv[3] + '.pulls', String(pulls)) },
        }))
      }
    `, { transfer: { maxOutputBytes: 4096 } })
    expect(execution.output.error).toMatchObject({ code: "SANDBOX_TASK_TRANSFER_LIMIT" })
    expect(execution.output.error?.message).toContain("maxOutputBytes")
    expect(Number(await readFile(`${execution.outputPath}.pulls`, "utf8"))).toBeLessThanOrEqual(4)
  })
  it("rejects Blob arrayBuffer overrides", async () => {
    const execution = await executePackageEntry(
      `export default () => {
        const blob = new Blob(["abcd"])
        blob.arrayBuffer = () => { throw new Error("oversized Blob was read") }
        return blob
      }`,
      { transfer: { maxSidecarBytes: 3 } },
    )
    expect(execution.code).toBe(1)
    expect(execution.output.error).toMatchObject({ code: "SANDBOX_TASK_SERIALIZATION_ERROR" })
    expect(execution.output.error?.message).toContain("arrayBuffer overrides")
    await expect(execution.readOutputFile(0)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects Blob subclasses before reading overrideable data", async () => {
    const execution = await executePackageEntry(
      `export default () => {
        class LargeBlob extends Blob {
          get size() { return 0 }
          arrayBuffer() { throw new Error("Blob subclass was read") }
        }
        return new LargeBlob(["oversized"])
      }`,
    )
    expect(execution.code).toBe(1)
    expect(execution.output.error).toMatchObject({ code: "SANDBOX_TASK_SERIALIZATION_ERROR" })
    expect(execution.output.error?.message).toContain("Blob subclasses are not supported")
  })

  it("uses the intrinsic Blob size despite an overridden size property", async () => {
    const execution = await executePackageEntry([
      "export default () => {",
      "  const blob = new Blob(['oversized'])",
      "  Object.defineProperty(blob, 'size', { value: 1 })",
      "  return blob",
      "}",
    ].join("\n"), { transfer: { maxSidecarBytes: 3 } })

    expect(execution.code).toBe(1)
    expect(execution.output.error?.code).toBe("SANDBOX_TASK_TRANSFER_LIMIT")
    expect(execution.output.error?.message).toContain("maxSidecarBytes")
  })

  it.each([true, false])("checks UTF-8 output bytes before writing success (accepted: %s)", async (accepted) => {
    const result = "é".repeat(2048)
    const bytes = Buffer.byteLength(JSON.stringify({ ok: true, result }))
    const execution = await executePackageEntry(`export default () => ${JSON.stringify(result)}`, {
      transfer: { maxSidecarBytes: 1024, maxOutputBytes: bytes - (accepted ? 0 : 1) },
    })
    expect(execution.code).toBe(accepted ? 0 : 1)
    if (accepted) {
      expect(execution.output.result).toBe(result)
    }
    else {
      expect(execution.output.result).toBeUndefined()
      expect(execution.output.error).toMatchObject({ code: "SANDBOX_TASK_TRANSFER_LIMIT" })
      expect(execution.output.error?.message).toContain("maxOutputBytes")
    }
  })

  it.each(["array", "object", "escaped"])("rejects excess input Blob bytes in %s values", async (shape) => {
    const first = new Blob(["ab"])
    const second = new Blob(["cd"])
    const value = shape === "array"
      ? [first, second]
      : shape === "object"
        ? { first, second }
        : { [SANDBOX_VALUE_MARKER]: first, second }
    const mkdir = vi.fn()
    const write = vi.fn()
    // SAFETY: Encoding rejects before any Sandbox operation; the test observes only the spies.
    const sandbox = { files: { mkdir, write } } as unknown as Parameters<typeof encodeSandboxTaskValue>[0]
    await expect(encodeSandboxTaskValue(sandbox, value, "/assets", "payload", undefined, {
      maxDepth: 32,
      maxSidecars: 2,
      maxSidecarBytes: 3,
    })).rejects.toMatchObject({
      code: "SANDBOX_TASK_TRANSFER_LIMIT",
      details: { label: "payload", limit: "maxSidecarBytes", maximum: 3, value: 4 },
    })
    expect(mkdir).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it.each(["maxSidecars", "maxSidecarBytes"] as const)("bounds files written for %s", async (limit) => {
    const execution = await executePackageEntry(
      'export default () => [new Blob([new Uint8Array([1, 2])]), new Uint8Array([3, 4]), Buffer.from([5, 6])]',
      { transfer: { maxSidecars: 3, maxSidecarBytes: 6, [limit]: limit === "maxSidecars" ? 1 : 3 } },
    )
    expect(execution.code).toBe(1)
    expect(execution.output.error).toMatchObject({ code: "SANDBOX_TASK_TRANSFER_LIMIT" })
    expect(execution.output.error?.message).toContain(limit)
    await expect(execution.readOutputFile(0)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(execution.readOutputFile(1)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(execution.readOutputFile(2)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["array", "object", "escaped"])("bounds recovery reads in %s values", async (shape) => {
    const binary = (id: number) => ({ [SANDBOX_VALUE_MARKER]: { tag: "binary", kind: "uint8array", id } })
    const value = shape === "array"
      ? [binary(0), binary(1)]
      : shape === "object"
        ? { a: binary(0), b: binary(1) }
        : { [SANDBOX_VALUE_MARKER]: { tag: "object", entries: [["a", binary(0)], ["b", binary(1)]] } }
    const read = vi.fn(async () => {
      await Promise.resolve()
      return new Uint8Array([1, 2])
    })
    // SAFETY: Decoding calls only `files.read` on the Sandbox.
    const sandbox = { files: { read } } as unknown as Parameters<typeof decodeSandboxTaskValue>[0]
    await expect(decodeSandboxTaskValue(sandbox, value, "/assets", "result", undefined, {
      maxDepth: 32,
      maxSidecars: 1,
      maxSidecarBytes: 4,
    })).rejects.toMatchObject({ code: "SANDBOX_TASK_TRANSFER_LIMIT", details: { limit: "maxSidecars" } })
    expect(read).toHaveBeenCalledTimes(1)
    await expect(decodeSandboxTaskValue(sandbox, value, "/assets", "result", undefined, {
      maxDepth: 32,
      maxSidecars: 2,
      maxSidecarBytes: 3,
    })).rejects.toMatchObject({ code: "SANDBOX_TASK_TRANSFER_LIMIT", details: { limit: "maxSidecarBytes" } })
  })

  it("bounds depth during result recovery", async () => {
    const read = vi.fn(async () => new Uint8Array([1]))
    // SAFETY: Decoding calls only `files.read` on the Sandbox.
    const sandbox = { files: { read } } as unknown as Parameters<typeof decodeSandboxTaskValue>[0]
    await expect(decodeSandboxTaskValue(sandbox, [[1]], "/assets", "result", undefined, {
      maxDepth: 1,
      maxSidecars: 1,
      maxSidecarBytes: 1,
    })).rejects.toMatchObject({ code: "SANDBOX_TASK_TRANSFER_LIMIT", details: { limit: "maxDepth", maximum: 1, value: 2 } })
    await expect(decodeSandboxTaskValue(sandbox, [1], "/assets", "result", undefined, {
      maxDepth: 1,
      maxSidecars: 1,
      maxSidecarBytes: 1,
    })).resolves.toEqual([1])
  })

  it("bounds depth during output extraction", async () => {
    const execution = await executePackageEntry('export default () => [[new Uint8Array([1])]]', {
      transfer: { maxDepth: 1, maxSidecars: 2, maxSidecarBytes: 4 },
    })
    expect(execution.output.error).toMatchObject({ code: "SANDBOX_TASK_TRANSFER_LIMIT" })
    expect(execution.output.error?.message).toContain("maxDepth")
    await expect(execution.readOutputFile(0)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("accepts output at the sidecar boundaries", async () => {
    const execution = await executePackageEntry('export default () => [new Blob(["ab"]), new Uint8Array([3, 4])]', {
      transfer: { maxDepth: 1, maxSidecars: 2, maxSidecarBytes: 4 },
    })
    expect(execution.code).toBe(0)
    expect(await execution.readOutputFile(1)).toEqual(Buffer.from([3, 4]))
  })
})
