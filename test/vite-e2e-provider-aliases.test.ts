import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, expect, it } from "vitest"

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
