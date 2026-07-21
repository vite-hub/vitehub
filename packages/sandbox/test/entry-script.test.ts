import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createEntrySource } from "../src/runtime/entry-script.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function executePackageEntry(definitionSource: string) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-package-entry-"))
  tempDirs.push(root)
  const definitionPath = join(root, "definition.mjs")
  const entryPath = join(root, "entry.mjs")
  const inputPath = join(root, "input.json")
  const outputPath = join(root, "output.json")
  await Promise.all([
    writeFile(definitionPath, definitionSource, "utf8"),
    writeFile(entryPath, createEntrySource(definitionPath, "module"), "utf8"),
    writeFile(inputPath, JSON.stringify({ context: {}, payload: {} }), "utf8"),
  ])

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
  return { code, output }
}

describe("package entry result transport", () => {
  it("returns a present JSON result", async () => {
    const execution = await executePackageEntry("await Promise.resolve(); export default { ok: true }\n")

    expect(execution).toEqual({
      code: 0,
      output: { ok: true, result: { ok: true } },
    })
  })

  it.each([
    ["legacy defineSandbox export", "export default { run() {} }\n", "remove defineSandbox({ run })"],
    ["legacy function export", "export default () => ({ ok: true })\n", "not a function"],
    ["missing default export", "export const value = true\n", "must default-export a result"],
    ["symbol result", "export default Symbol('result')\n", "unsupported symbol"],
    ["nested undefined", "export default { value: undefined }\n", "unsupported undefined"],
    ["bigint result", "export default 1n\n", "unsupported bigint"],
    [
      "cyclic result",
      "const value = {}; value.self = value; export default value\n",
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
