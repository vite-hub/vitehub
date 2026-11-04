import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { restoreLinksScript, snapshotLinksFile } from "../src/links.ts"
import { lockedAliases, withoutTarballIntegrity } from "../src/lockfile.ts"
import { readTree } from "../src/tree.ts"

const run = promisify(execFile)
const exists = (path: string) => lstat(path).then(() => true, () => false)

let outer: string
let project: string
beforeEach(async () => {
  outer = await mkdtemp(join(tmpdir(), "snapshot-files-"))
  project = join(outer, "project")
  await mkdir(join(project, "node_modules/a"), { recursive: true })
  await mkdir(join(project, "node_modules/.bin"))
  await writeFile(join(project, "node_modules/a/cli.js"), "#!/usr/bin/env node\n")
  await writeFile(join(outer, "outside.txt"), "not part of the project")
  await chmod(join(outer, "outside.txt"), 0o644)
})
afterEach(() => rm(outer, { recursive: true, force: true }))

describe("restoring snapshot links", () => {
  it("restores links and executables inside the project and skips every path that leaves it", async () => {
    await writeFile(join(project, "node_modules", snapshotLinksFile), JSON.stringify({
      links: [
        ["node_modules/.bin/a", "../a/cli.js"],
        ["../escape-link", "project/node_modules/a/cli.js"],
        [join(outer, "absolute-link"), "project/node_modules/a/cli.js"],
        ["node_modules/../../dotdot-link", "project/node_modules/a/cli.js"],
        ["node_modules/.bin/up", "../../../outside.txt"],
        ["node_modules/.bin/absolute", join(outer, "outside.txt")],
      ],
      executables: ["node_modules/a/cli.js", "../outside.txt", join(outer, "outside.txt")],
    }))
    await writeFile(join(project, "restore.cjs"), restoreLinksScript)
    const { stderr } = await run(process.execPath, ["restore.cjs"], { cwd: project })

    expect(await readlink(join(project, "node_modules/.bin/a"))).toBe("../a/cli.js")
    expect((await stat(join(project, "node_modules/a/cli.js"))).mode & 0o777).toBe(0o755)
    for (const path of ["escape-link", "absolute-link", "dotdot-link"]) expect(await exists(join(outer, path))).toBe(false)
    expect(await exists(join(project, "node_modules/.bin/up"))).toBe(false)
    expect(await exists(join(project, "node_modules/.bin/absolute"))).toBe(false)
    expect((await stat(join(outer, "outside.txt"))).mode & 0o777).toBe(0o644)
    expect(stderr).toContain("Skipped snapshot links outside the project")
  })
})

describe("reading the snapshot tree", () => {
  it("keeps links inside the project and leaves out links that leave it or point at nothing", async () => {
    await chmod(join(project, "node_modules/a/cli.js"), 0o755)
    await symlink("../a/cli.js", join(project, "node_modules/.bin/a"))
    await symlink(join(outer, "outside.txt"), join(project, "node_modules/.bin/absolute"))
    await symlink("../../../outside.txt", join(project, "node_modules/.bin/up"))
    await symlink("../missing/cli.js", join(project, "node_modules/.bin/dangling"))
    const links = { links: [] as [string, string][], executables: [] as string[] }
    const tree = await readTree(project, join(project, "node_modules"), links)
    expect(links).toEqual({ links: [["node_modules/.bin/a", "../a/cli.js"]], executables: ["node_modules/a/cli.js"] })
    expect(Object.keys(tree)).toEqual([".bin", "a"])
  })
})

describe("snapshot lockfiles", () => {
  const lockfile = JSON.stringify({
    packages: {
      "": { dependencies: { "vite-hub": "file:./tarballs/vite-hub-0.1.0.tgz", "vitehub-wasm-esbuild-wasm-0.28.2": "npm:esbuild-wasm@0.28.2" } },
      "node_modules/vite-hub": { resolved: "file:tarballs/vite-hub-0.1.0.tgz", integrity: "sha512-changes-on-every-build" },
      "node_modules/zod": { resolved: "https://registry.npmjs.org/zod/-/zod-4.6.5.tgz", integrity: "sha512-registry" },
    },
  })

  it("reads the wasm aliases that a lockfile pins", () => {
    expect(lockedAliases(lockfile)).toEqual({ "vitehub-wasm-esbuild-wasm-0.28.2": "npm:esbuild-wasm@0.28.2" })
  })

  it("drops the integrity of packed tarballs only, so a rebuilt tarball still installs with npm ci", () => {
    const packages = JSON.parse(withoutTarballIntegrity(lockfile)).packages
    expect(packages["node_modules/vite-hub"].integrity).toBeUndefined()
    expect(packages["node_modules/zod"].integrity).toBe("sha512-registry")
  })
})
