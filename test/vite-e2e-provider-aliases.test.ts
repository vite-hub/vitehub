import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, expect, it } from "vitest"

import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"

import { prepareFeatureArtifacts } from "../playground/vite/build/vite-e2e.ts"

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

it("redirects source and packaged KV Vite entries in hosted output", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-kv-vite-aliases-"))
  directories.push(rootDir)

  const artifacts = await prepareFeatureArtifacts({
    clientOutDir: join(rootDir, "dist", "client"),
    hosting: "cloudflare",
    kv: false,
    rootDir,
  })
  const guard = artifacts.alias["@vite-hub/kv/vite"]
  const canonicalWorkspaceRoot = await realpath(workspaceRoot)

  expect(artifacts.alias[resolve(workspaceRoot, "packages/kv/src/vite.ts")]).toBe(guard)
  expect(artifacts.alias[resolve(canonicalWorkspaceRoot, "packages/kv/dist/vite.js")]).toBe(guard)
})

it.each(["cloudflare", "vercel"] as const)("bundles Sandbox Task runtime and provider imports for %s", async (hosting) => {
  const rootDir = await mkdtemp(join(workspaceRoot, ".vite-e2e-sandbox-"))
  directories.push(rootDir)
  const taskDir = join(rootDir, "server", "sandbox-tasks", "greet")
  await mkdir(taskDir, { recursive: true })
  await writeFile(join(taskDir, "package.json"), '{ "type": "module" }')
  await writeFile(join(taskDir, "index.ts"), 'export default async function greet() { return "hello" }')

  const artifacts = await prepareFeatureArtifacts({
    clientOutDir: join(rootDir, "dist", "client"),
    hosting,
    rootDir,
    sandbox: { provider: hosting },
  })
  const entry = join(rootDir, "entry.mjs")
  await writeFile(entry, [
    'export * from "@vite-hub/sandbox/task"',
    'export * from "@vite-hub/sandbox/task/runtime/state"',
    'export * from "#vitehub-sandbox-task-provider-loader"',
  ].join("\n"))

  await expect(bundleEsmEntry(entry, join(rootDir, "bundle.mjs"), {
    alias: artifacts.alias,
    external: ["@cloudflare/sandbox", "@vercel/sandbox", "cloudflare:workers"],
    platform: "node",
  })).resolves.toBeUndefined()
})
