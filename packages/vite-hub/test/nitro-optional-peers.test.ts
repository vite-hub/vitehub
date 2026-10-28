import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"

import { nitroOptionalPeers } from "../src/internal/nitro-optional-peers.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it("externalizes only absent optional dependencies declared by the importing package", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-optional-peers-"))
  roots.push(root)
  await mkdir(join(root, "dist"))
  const importer = join(root, "dist/runtime.js")
  await writeFile(importer, "")
  await writeFile(join(root, "package.json"), JSON.stringify({
    type: "module",
    peerDependenciesMeta: { "@channel/missing": { optional: true }, required: { optional: false }, present: { optional: true } },
    optionalDependencies: { native: "*" },
  }))
  await mkdir(join(root, "node_modules/present"), { recursive: true })
  await writeFile(join(root, "node_modules/present/package.json"), JSON.stringify({ name: "present", exports: { import: "./index.js" } }))
  await writeFile(join(root, "node_modules/present/index.js"), "export default true")
  const plugin = nitroOptionalPeers()
  const resolveId = plugin.resolveId
  if (typeof resolveId !== "function") throw new TypeError("Expected a resolver")
  const resolve = (source: string, from = importer) => Reflect.apply(resolveId, {}, [source, from])
  expect(resolve("@channel/missing")).toEqual({ id: "@channel/missing", external: true })
  expect(resolve("@channel/missing/subpath")).toEqual({ id: "@channel/missing/subpath", external: true })
  expect(resolve("native")).toEqual({ id: "native", external: true })
  expect(resolve("present")).toBeUndefined()
  expect(resolve("present/missing-subpath")).toBeUndefined()
  expect(resolve("required")).toBeUndefined()
  expect(resolve("undeclared")).toBeUndefined()
  expect(resolve("./relative.js")).toBeUndefined()
  expect(resolve("node:fs")).toBeUndefined()
  expect(resolve("#virtual")).toBeUndefined()
  expect(resolve("@channel/missing", "\0virtual")).toBeUndefined()
  const aliasResolver = nitroOptionalPeers({ alias: { "@channel/missing": "/custom-adapter.js" } }).resolveId
  if (typeof aliasResolver !== "function") throw new TypeError("Expected a resolver")
  expect(Reflect.apply(aliasResolver, {}, ["@channel/missing", importer])).toBeUndefined()
  expect(Reflect.apply(aliasResolver, {}, ["@channel/missing/subpath", importer])).toBeUndefined()
  const app = join(root, "app")
  await mkdir(app)
  await writeFile(join(app, "package.json"), "{}")
  await writeFile(join(app, "entry.js"), "")
  expect(resolve("@channel/missing", join(app, "entry.js"))).toBeUndefined()
})
