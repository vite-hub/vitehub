import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { noWorkspaceVersions } from "../src/runnable/build.ts"
import { buildTutorialSnapshots, devServerInDevDependencies, readManifest, readTutorialSnapshots, sortPackedManifest, tutorialLockfile, tutorialSnapshotInputs } from "../src/runnable/snapshots.ts"

let dir: string
beforeEach(async () => { dir = await mkdtemp(resolve(tmpdir(), "runnable-snapshots-")) })
afterEach(() => rm(dir, { recursive: true, force: true }))

const tutorials = { "first-agent": { parts: ["first-agent.abc.0.bin"], sha256: "abc" } }

describe("reading tutorial snapshots", () => {
  it("disables cached snapshots and their public assets when explicitly requested", async () => {
    await mkdir(resolve(dir, "snapshots"))
    await writeFile(resolve(dir, "snapshots/old.0.bin"), "stale dependencies")
    await writeFile(resolve(dir, "snapshots.json"), JSON.stringify({ inputs: "current", tutorials }))
    await writeFile(resolve(dir, "first-agent-starter.zip"), "starter")

    // Dev without an explicit opt-out can still reuse the last build.
    expect(await readTutorialSnapshots(dir, { inputs: "current" })).toEqual(tutorials)
    expect(await readTutorialSnapshots(dir, { inputs: "current", disabled: true })).toBeUndefined()
    expect(await readdir(dir)).toEqual(["first-agent-starter.zip"])
    expect(await readFile(resolve(dir, "first-agent-starter.zip"), "utf8")).toBe("starter")
    expect(await readTutorialSnapshots(dir, { inputs: "current" })).toBeUndefined()
  })

  it("ignores snapshots that were built from other dependencies, so the workspace installs instead", async () => {
    await writeFile(resolve(dir, "snapshots.json"), JSON.stringify({ inputs: "before", tutorials }))
    expect(await readTutorialSnapshots(dir, { inputs: "after" })).toBeUndefined()
    // The format before input hashes was a plain map of parts.
    await writeFile(resolve(dir, "snapshots.json"), JSON.stringify({ "first-agent": ["/_tutorials/snapshots/old.0.bin"] }))
    expect(await readTutorialSnapshots(dir, { inputs: "after" })).toBeUndefined()
  })
})

describe("tutorial snapshot inputs", () => {
  const source = { slug: "first-agent", page: "/docs/getting-started/first-agent", fixture: "first-agent" }
  const versions = { catalogs: { default: { zod: "4.6.5" } }, packages: { "vite-hub": "0.1.0" } }

  async function layout() {
    await mkdir(resolve(dir, "fixtures/first-agent"), { recursive: true })
    await mkdir(resolve(dir, "packages/vite-hub"), { recursive: true })
    await writeFile(resolve(dir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")
    await writeFile(resolve(dir, "fixtures/first-agent/package.json"), JSON.stringify({ dependencies: { "vite-hub": "workspace:*" } }))
    await writeFile(resolve(dir, "packages/vite-hub/package.json"), JSON.stringify({ name: "vite-hub", dependencies: { zod: "catalog:" } }))
    await writeFile(resolve(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    await writeFile(tutorialLockfile(resolve(dir, "fixtures"), "first-agent"), "{}\n")
  }
  const inputs = (catalogs = versions, workspace = true) => tutorialSnapshotInputs({
    tutorials: [source],
    workspaceRoot: workspace ? dir : undefined,
    fixturesDir: resolve(dir, "fixtures"),
    versions: catalogs,
  })

  it("keeps the npm lockfile beside the fixture folder", () => {
    expect(tutorialLockfile("/app/fixtures", "first-agent")).toBe(resolve("/app/fixtures/first-agent.package-lock.json"))
  })

  it("stays the same for the same files", async () => {
    await layout()
    expect(await inputs()).toBe(await inputs())
  })

  it.each([
    ["the fixture manifest", "fixtures/first-agent/package.json"],
    ["a workspace package manifest", "packages/vite-hub/package.json"],
    ["the workspace lockfile", "pnpm-lock.yaml"],
    ["the fixture lockfile", "fixtures/first-agent.package-lock.json"],
  ])("changes with %s", async (_, path) => {
    await layout()
    const before = await inputs()
    await writeFile(resolve(dir, path), "{\"changed\":true}\n")
    expect(await inputs()).not.toBe(before)
  })

  it("changes with a catalog version", async () => {
    await layout()
    expect(await inputs({ ...versions, catalogs: { default: { zod: "4.7.0" } } })).not.toBe(await inputs())
  })

  it("reads no workspace files without a pnpm workspace", async () => {
    await layout()
    const before = await inputs(versions, false)
    await writeFile(resolve(dir, "pnpm-lock.yaml"), "lockfileVersion: '10.0'\n")
    await writeFile(resolve(dir, "packages/vite-hub/package.json"), "{\"changed\":true}\n")
    expect(await inputs(versions, false)).toBe(before)
  })
})

describe("fixture manifests", () => {
  it("reads the fields of a package.json that a snapshot uses, and nothing from invalid JSON", () => {
    const manifest = readManifest(JSON.stringify({
      name: "kv",
      scripts: { dev: "vite" },
      dependencies: { "vite-hub": "workspace:*", "broken": 1 },
      peerDependencies: { vue: "^3.5.0", h3: "^2.0.0" },
      peerDependenciesMeta: { h3: { optional: true } },
    }))
    expect(manifest).toMatchObject({ name: "kv", private: false, dependencies: { "vite-hub": "workspace:*" }, devDependencies: {}, peerDependencies: { vue: "^3.5.0", h3: "^2.0.0" } })
    expect([...manifest.optionalPeers]).toEqual(["h3"])
    expect(readManifest("not json")).toMatchObject({ name: undefined, dependencies: {} })
    expect(readManifest("[]")).toMatchObject({ name: undefined, dependencies: {} })
  })

  it("finds a dev server that only devDependencies install", () => {
    // The snapshot installs `dependencies`, so the dev server must be one of them.
    expect(devServerInDevDependencies(readManifest(JSON.stringify({ scripts: { dev: "vite --host" }, devDependencies: { vite: "^8.0.0" } })))).toBe("vite")
    expect(devServerInDevDependencies(readManifest(JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "^8.0.0" } })))).toBeUndefined()
    expect(devServerInDevDependencies(readManifest(JSON.stringify({ dependencies: { vite: "^8.0.0" } })))).toBeUndefined()
  })
})

describe("building tutorial snapshots", () => {
  it("builds no snapshot for a fixture without dependencies, which has no node_modules", async () => {
    await mkdir(resolve(dir, "fixtures/first-server"), { recursive: true })
    await writeFile(resolve(dir, "fixtures/first-server/package.json"), JSON.stringify({ type: "module", scripts: { dev: "node server.mjs" } }))
    const snapshots = await buildTutorialSnapshots({
      tutorials: [{ slug: "first-server", page: "/docs/try/first-server", fixture: "first-server" }],
      fixturesDir: resolve(dir, "fixtures"),
      versions: noWorkspaceVersions,
      outDir: resolve(dir, "out"),
      workDir: resolve(dir, "work"),
    })
    expect(snapshots).toEqual({})
    expect(JSON.parse(await readFile(resolve(dir, "out/snapshots.json"), "utf8")).tutorials).toEqual({})
  })
})

describe("packed manifests", () => {
  it("sorts the dependency fields of a packed package.json, so the order of pnpm pack does not reach the snapshot", async () => {
    const { execFileSync } = await import("node:child_process")
    const pack = (dependencies: Record<string, string>) => {
      const source = resolve(dir, "source")
      execFileSync("rm", ["-rf", source])
      execFileSync("mkdir", ["-p", resolve(source, "package")])
      return writeFile(resolve(source, "package/package.json"), JSON.stringify({ name: "vite-hub", dependencies, files: ["dist"] }))
        .then(() => execFileSync("tar", ["-czf", resolve(dir, "vite-hub.tgz"), "-C", source, "package"]))
        .then(() => sortPackedManifest(resolve(dir, "vite-hub.tgz"), resolve(dir, "scratch")))
        .then(() => {
          execFileSync("rm", ["-rf", resolve(dir, "out")])
          execFileSync("mkdir", ["-p", resolve(dir, "out")])
          execFileSync("tar", ["-xzf", resolve(dir, "vite-hub.tgz"), "-C", resolve(dir, "out")])
          return readFile(resolve(dir, "out/package/package.json"), "utf8")
        })
    }
    const first = await pack({ "@vite-hub/runtime": "0.1.0", "@vite-hub/blob": "0.1.0", "zod": "4.6.5" })
    const second = await pack({ "zod": "4.6.5", "@vite-hub/blob": "0.1.0", "@vite-hub/runtime": "0.1.0" })
    expect(first).toBe(second)
    expect(Object.keys(JSON.parse(first).dependencies)).toEqual(["@vite-hub/blob", "@vite-hub/runtime", "zod"])
    expect(JSON.parse(first).files).toEqual(["dist"])
  })
})
