import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire, findPackageJSON, registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, it, vi } from "vitest"

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
  const resolveDependency = vi.fn(async () => null)
  const resolve = (source: string, from = importer) => Reflect.apply(resolveId, { resolve: resolveDependency }, [source, from])
  expect(await resolve("@channel/missing")).toEqual({ id: "@channel/missing", external: true })
  expect(await resolve("@channel/missing/subpath")).toEqual({ id: "@channel/missing/subpath", external: true })
  expect(await resolve("native")).toEqual({ id: "native", external: true })
  expect(await resolve("present")).toBeUndefined()
  expect(await resolve("present/missing-subpath")).toBeUndefined()
  expect(await resolve("required")).toBeUndefined()
  expect(await resolve("undeclared")).toBeUndefined()
  expect(await resolve("./relative.js")).toBeUndefined()
  expect(await resolve("node:fs")).toBeUndefined()
  expect(await resolve("#virtual")).toBeUndefined()
  expect(await resolve("@channel/missing", "\0virtual")).toBeUndefined()
  const aliasResolver = nitroOptionalPeers({ alias: { "@channel/missing": "/custom-adapter.js" } }).resolveId
  if (typeof aliasResolver !== "function") throw new TypeError("Expected a resolver")
  expect(await Reflect.apply(aliasResolver, {}, ["@channel/missing", importer])).toBeUndefined()
  expect(await Reflect.apply(aliasResolver, {}, ["@channel/missing/subpath", importer])).toBeUndefined()
  const app = join(root, "app")
  await mkdir(app)
  await writeFile(join(app, "package.json"), "{}")
  await writeFile(join(app, "entry.js"), "")
  expect(await resolve("@channel/missing", join(app, "entry.js"))).toBeUndefined()
  expect(resolveDependency).toHaveBeenCalledTimes(3)

  resolveDependency.mockRejectedValueOnce(new Error(`Cannot resolve "native" from ${JSON.stringify(importer)} and externals are not allowed!`))
  expect(await resolve("native")).toEqual({ id: "native", external: true })
  const failure = new Error("Resolver configuration failed")
  resolveDependency.mockRejectedValueOnce(failure)
  await expect(resolve("native")).rejects.toBe(failure)
})

it("preserves optional packages supplied by registered resolution hooks without node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-optional-pnp-"))
  roots.push(root)
  const importer = join(root, "runtime.js")
  const installed = join(root, "pnp-peer.js")
  await writeFile(importer, "")
  await writeFile(installed, "export default true")
  await writeFile(join(root, "package.json"), JSON.stringify({ optionalDependencies: { "pnp-peer": "*" } }))
  const hooks = registerHooks({
    resolve(source, context, nextResolve) {
      return source === "pnp-peer" ? { url: pathToFileURL(installed).href, shortCircuit: true } : nextResolve(source, context)
    },
  })
  try {
    expect(() => findPackageJSON("pnp-peer/package.json", pathToFileURL(importer))).toThrow()
    const resolve = vi.fn(async (source: string, from: string) => ({ id: createRequire(from).resolve(source) }))
    const resolveId = nitroOptionalPeers().resolveId
    if (typeof resolveId !== "function") throw new TypeError("Expected a resolver")
    const options = { custom: { fixture: true }, isEntry: false }
    expect(await Reflect.apply(resolveId, { resolve }, ["pnp-peer", importer, options])).toEqual({ id: installed })
    expect(resolve).toHaveBeenCalledWith("pnp-peer", importer, { ...options, skipSelf: true })
  }
  finally {
    hooks.deregister()
  }
})
