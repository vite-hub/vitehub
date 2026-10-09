import { execFile } from "node:child_process"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterAll, beforeAll, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, "..")
let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-kv-dev-import-"))
  const archive = join(root, "kv.tgz")
  await execFileAsync("corepack", ["pnpm", "pack", "--out", archive], { cwd: packageRoot })
  await execFileAsync("tar", ["-xzf", archive, "-C", root])
  await symlink(join(packageRoot, "node_modules"), join(root, "node_modules"), "junction")
})

afterAll(async () => {
  if (root) await rm(root, { force: true, recursive: true })
})

async function importDevRuntime(assertions: string, configSource?: string) {
  const configFile = join(root, "package", "config.mjs")
  if (configSource !== undefined) await writeFile(configFile, configSource)
  const script = [
    'import assert from "node:assert/strict"',
    ...(configSource === undefined ? [] : [
      'import { registerHooks } from "node:module"',
      "registerHooks({ resolve(specifier, context, nextResolve) {",
      `  if (specifier === "#vitehub/kv/config") return { shortCircuit: true, url: ${JSON.stringify(pathToFileURL(configFile).href)} }`,
      "  return nextResolve(specifier, context)",
      "} })",
    ]),
    `const { handleKVDevRequest, listKVDevStores } = await import(${JSON.stringify(pathToFileURL(join(root, "package", "dist", "runtime", "dev.js")).href)})`,
    assertions,
  ].join("\n")
  return execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { cwd: root })
}

it("imports the packed dev runtime without generated config and reports disabled KV", async () => {
  await importDevRuntime([
    "assert.deepEqual(listKVDevStores(), [])",
    'const request = new Request("http://localhost/_vitehub/kv/dev", {',
    '  method: "POST", headers: { "content-type": "application/json", "x-vitehub-kv-dev": "1" },',
    '  body: JSON.stringify({ operation: "list" }),',
    "})",
    "const response = await handleKVDevRequest(request)",
    "assert.equal(response.status, 409)",
    'assert.equal((await response.json()).error.code, "KV_DISABLED")',
  ].join("\n"))
})

it("loads the generated KV stores in the packed dev runtime", async () => {
  await importDevRuntime(
    'assert.deepEqual(listKVDevStores(), [{ driver: "fs-lite", name: "default" }])',
    'export const kv = { store: { base: "/unused", driver: "fs-lite" } }',
  )
})

it("preserves a generated config dependency failure", async () => {
  await expect(importDevRuntime("", 'import "missing-kv-config-dependency"; export const kv = false'))
    .rejects.toMatchObject({ stderr: expect.stringContaining("Cannot find package 'missing-kv-config-dependency'") })
})

it("preserves a generated config evaluation failure", async () => {
  await expect(importDevRuntime("", 'throw new Error("broken generated KV config"); export const kv = false'))
    .rejects.toMatchObject({ stderr: expect.stringContaining("broken generated KV config") })
})
