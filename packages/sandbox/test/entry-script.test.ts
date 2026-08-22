import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createEntrySource } from "../src/runtime/entry-script.ts"
import { SANDBOX_VALUE_MARKER } from "../src/runtime/binary-sidecars.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function executePackageEntry(definitionSource: string, options: {
  input?: unknown
  inputFiles?: Record<number, Uint8Array>
  inputJson?: string
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-package-entry-"))
  tempDirs.push(root)
  const definitionPath = join(root, "definition.mjs")
  const entryPath = join(root, "entry.mjs")
  const inputPath = join(root, "input.json")
  const outputPath = join(root, "output.json")
  await Promise.all([
    writeFile(definitionPath, definitionSource, "utf8"),
    writeFile(entryPath, createEntrySource(definitionPath, "module"), "utf8"),
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
  const output = JSON.parse(await readFile(outputPath, "utf8")) as {
    error?: { message?: string }
    ok: boolean
    result?: unknown
  }
  return {
    code,
    output,
    readOutputFile: async (id: number) => await readFile(join(`${outputPath}.files`, String(id))),
  }
}

describe("package entry result transport", () => {
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
      `export default async function () { return { boolean: new Boolean(true), number: new Number(5), string: new String('ready') } }\n`,
    )

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
