import { copyFile, glob, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import { describe, expect, it } from "vitest"

import { repoRoot, run, type PackageManifest } from "../consumer/packed-app.ts"
import { nuxt, selectedTemplates } from "./templates.ts"

const bannedPackages = ["@nuxt/ui", "reka-ui"]

describe.each(selectedTemplates)("$name gates", (template) => {
  it("does not depend on Nuxt UI or Reka UI", async () => {
    const manifest = JSON.parse(await readFile(join(template.dir, "package.json"), "utf8")) as PackageManifest
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })

    expect(dependencies.filter(name => bannedPackages.includes(name))).toEqual([])
  })

  it("passes nuxt typecheck", async () => {
    await nuxt(template, ["typecheck"])
  }, 600_000)

  it("installs and builds from npm outside the workspace", async () => {
    const appDir = await mkdtemp(join(tmpdir(), `vitehub-template-${template.name}-`))
    try {
      const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", relative(repoRoot, template.dir)], repoRoot)
      for (const file of stdout.trim().split("\n")) {
        const target = join(appDir, relative(template.dir, join(repoRoot, file)))
        await mkdir(dirname(target), { recursive: true })
        await copyFile(join(repoRoot, file), target)
      }
      const env = { ...process.env, NUXT_TELEMETRY_DISABLED: "1" }
      await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], appDir, env)
      const installed = await Array.fromAsync(glob(bannedPackages.map(name => `**/node_modules/${name}/package.json`), { cwd: appDir }))

      expect(installed).toEqual([])
      await run(join(appDir, "node_modules/.bin/nuxt"), ["build"], appDir, env)
    }
    finally {
      await rm(appDir, { force: true, recursive: true })
    }
  }, 900_000)
})
