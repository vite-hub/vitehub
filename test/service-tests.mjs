#!/usr/bin/env node
// Runs the package tests that need a real Postgres or Redis. A test file opts in when it reads
// VITEHUB_TEST_POSTGRES_URL or VITEHUB_TEST_REDIS_URL. CI starts both as service containers and
// sets the two variables, so a new test file needs no CI change.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const serviceVariables = Object.freeze(["VITEHUB_TEST_POSTGRES_URL", "VITEHUB_TEST_REDIS_URL"])

const leadingBuild = /^vp run (?:--cache )?-t ([@\w./-]+)#build$/

/** Lists the package test files that read a service variable, relative to `root`. */
export function findServiceTests(root) {
  const result = spawnSync("git", [
    "grep",
    "-l",
    "-E",
    serviceVariables.join("|"),
    "--",
    ":(glob)packages/*/test/**/*.test.ts",
  ], { cwd: root, encoding: "utf8" })
  // git grep exits with 1 when no file matches.
  if (result.status === 1) return []
  if (result.status !== 0) throw new Error(`git grep failed: ${result.stderr || result.error?.message}`)
  return result.stdout.split("\n").filter(Boolean).sort()
}

/** Groups test files by package directory, for example `packages/kv` -> [`test/redis.test.ts`]. */
export function groupByPackage(files) {
  const groups = new Map()
  for (const file of files) {
    const [, name] = file.split("/")
    const directory = `packages/${name}`
    groups.set(directory, [...groups.get(directory) ?? [], relative(directory, file)])
  }
  return groups
}

/** Returns the builds that a package `test` script runs before `vp test`, such as `vp run -t @vite-hub/kv#build`. */
export function packageBuilds(testScript) {
  const builds = []
  for (const part of String(testScript ?? "").split("&&").map(command => command.trim())) {
    const match = leadingBuild.exec(part)
    if (!match) break
    builds.push(match[1])
  }
  return builds
}

function runVp(vp, args, cwd) {
  console.log(`[service-tests] ${relative(process.cwd(), cwd) || "."}: vp ${args.join(" ")}`)
  const result = spawnSync(process.execPath, [vp, ...args], { cwd, stdio: "inherit" })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function main() {
  const root = resolve(import.meta.dirname, "..")
  const groups = groupByPackage(findServiceTests(root))
  if (process.argv.includes("--list")) {
    for (const [directory, files] of groups) console.log(`${directory}: ${files.join(" ")}`)
    return
  }
  if (groups.size === 0) {
    console.log(`[service-tests] No package test reads ${serviceVariables.join(" or ")}.`)
    return
  }
  const sources = [...groups].flatMap(([directory, files]) => files.map(file => readFileSync(join(root, directory, file), "utf8")))
  const missing = serviceVariables.filter(name => sources.some(source => source.includes(name)) && !process.env[name])
  if (missing.length) {
    // Without the variables the tests skip, and a skipped run must not look like a pass.
    console.error(`[service-tests] Set ${missing.join(" and ")}. A service test skips when its variable is not set.`)
    process.exit(1)
  }

  const vp = fileURLToPath(new URL("./bin/vp", import.meta.resolve("vite-plus/package.json")))
  for (const [directory, files] of groups) {
    const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"))
    for (const name of packageBuilds(manifest.scripts?.test)) runVp(vp, ["run", "--cache", "-t", `${name}#build`], root)
    runVp(vp, ["test", "run", ...files], join(root, directory))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
