import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const packageRoot = join(repoRoot, "packages")

function publicPackages() {
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const manifestPath = join(packageRoot, entry.name, "package.json")
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
        return manifest.private === true ? undefined : { name: manifest.name, manifestPath }
      }
      catch (error) {
        if (error.code === "ENOENT") return undefined
        throw error
      }
    })
    .filter(packageInfo => packageInfo?.name)
    .toSorted((left, right) => left.name.localeCompare(right.name))
}

function command(file, args) {
  return execFileSync(file, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
}

function packPackages(packDirectory, packages) {
  const output = command("corepack", [
    "pnpm",
    "--recursive",
    "--workspace-concurrency=1",
    ...packages.flatMap(packageInfo => ["--filter", packageInfo.name]),
    "pack",
    "--pack-destination", packDirectory,
    "--json",
  ])
  const packed = JSON.parse(output)
  if (!Array.isArray(packed) || packed.length !== packages.length) {
    throw new Error(`Expected ${packages.length} packed public packages, received ${Array.isArray(packed) ? packed.length : "an invalid result"}`)
  }
  return packed.map(packageInfo => resolve(packageInfo.filename))
}

function main() {
  const packages = publicPackages()
  const packDirectory = mkdtempSync(join(tmpdir(), "vitehub-package-metadata-"))

  try {
    for (const tarball of packPackages(packDirectory, packages)) {
      // @vite-hub/auth already owns the repository's publint dependency. Run
      // through that workspace package so this check does not add another copy
      // of the tool to every package or to the root manifest.
      command("corepack", [
        "pnpm",
        "exec",
        "vp",
        "exec",
        "--filter", "@vite-hub/auth",
        "--",
        "publint", "run", tarball, "--strict",
      ])
    }
  }
  finally {
    rmSync(packDirectory, { force: true, recursive: true })
  }

  console.log(`Validated ${packages.length} packed public packages with publint --strict.`)
}

main()
