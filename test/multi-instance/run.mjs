#!/usr/bin/env node
// Runs one built Nuxt 5 app as three Node instances against one Postgres and one Redis,
// then checks that each primitive behaves as one application across the instances.
// Read README.md in this folder before you change it.
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"

import { checks } from "./checks.mjs"

const here = import.meta.dirname
const repoRoot = resolve(here, "../..")
const log = message => console.log(`[multi-instance] ${message}`)

const { values: options } = parseArgs({
  options: {
    app: { type: "string" },
    keep: { type: "boolean", default: false },
    // Without Redis, the build and the instances see only DATABASE_URL, so Postgres must carry every shared store.
    "no-redis": { type: "boolean", default: false },
    only: { type: "string" },
  },
})

// The feature packages that the fixture enables. Packing follows their workspace dependencies.
const fixturePackages = ["vite-hub", "blob", "cli", "database", "kv", "queue", "rate-limit", "realtime", "schedule", "workflow"]

// Framework pins match the packed Nuxt 5 consumer tests. Drizzle matches the Database package.
const appDependencies = {
  "drizzle-kit": "1.0.0-rc.5",
  "drizzle-orm": "1.0.0-rc.5",
  h3: "2.0.8",
  nitro: "3.0.261102-rc",
  nuxt: "npm:nuxt-nightly@5.0.0-2611031025-9496b7e",
  openworkflow: "0.9.2",
  postgres: "3.4.9",
  rolldown: "1.1.5",
  unplugin: "3.3.0",
  vite: "8.0.8",
  // The vite override points at vite-plus-core, which loads its native binding from vite-plus.
  "vite-plus": "0.1.24",
  // The Realtime check connects Yjs peers from the harness with these packages.
  ws: "8.22.0",
  "y-websocket": "3.1.0",
  yjs: "13.6.33",
}
const appOverrides = {
  "@napi-rs/wasm-runtime": "1.1.6",
  "@nestjs/common": "11.2.3",
  "@nestjs/core": "11.2.3",
  "mdast-util-gfm-table": "2.0.0",
  "msgpackr-extract": "3.0.4",
  "msgpackr@^2": "2.1.0",
  nitro: "3.0.261102-rc",
  "nitro>h3": "2.0.8",
  "oxc-parser": "0.140.0",
  rolldown: "1.2.4",
  vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
  vue: "3.5.44",
}

const mode = options["no-redis"] ? "without-redis" : "with-redis"
const knownChecks = JSON.parse(readFileSync(join(here, "known-failing.json"), "utf8"))
const knownFailing = knownChecks[mode]
// A flaky check may pass or fail. It never changes the exit code.
const flaky = knownChecks.flaky

// Every child process starts from this environment. Without Redis, a REDIS_URL from the shell must not reach
// the build or the instances, so drop it here once.
const baseEnv = { ...process.env }
if (mode === "without-redis") delete baseEnv.REDIS_URL
const instanceNames = ["a", "b", "c"]
const cleanups = []

function run(command, args, { cwd = repoRoot, env, logFile } = {}) {
  log(`${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    maxBuffer: 256 * 1024 * 1024,
  })
  const output = `${result.stdout || ""}${result.stderr || ""}`
  if (logFile) writeFileSync(logFile, output)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`})\n${output.slice(-4000)}`)
  }
  return output
}

async function freePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address()
  server.close()
  await once(server, "close")
  return port
}

async function startBackends(project) {
  const env = {
    MULTI_INSTANCE_POSTGRES_PORT: String(await freePort()),
    MULTI_INSTANCE_REDIS_PORT: String(await freePort()),
  }
  const compose = ["compose", "-p", project, "-f", join(here, "compose.yaml")]
  cleanups.push(() => run("docker", [...compose, "down", "-v", "--remove-orphans"], { env }))
  run("docker", [...compose, "up", "-d", "--wait", "postgres", ...(mode === "with-redis" ? ["redis"] : [])], { env })
  return {
    databaseUrl: `postgres://vitehub:vitehub@127.0.0.1:${env.MULTI_INSTANCE_POSTGRES_PORT}/vitehub`,
    // Only set REDIS_URL when Redis runs. The build and the instances must not see it in the other mode.
    redisEnv: mode === "with-redis" ? { REDIS_URL: `redis://127.0.0.1:${env.MULTI_INSTANCE_REDIS_PORT}` } : {},
  }
}

async function packWorkspace(packDir) {
  const { packedWorkspacePackages } = await import("../../packages/internal/test-utils/published-types.ts")
  const names = await packedWorkspacePackages(repoRoot, fixturePackages)
  const specs = {}
  for (const name of names) {
    const packageName = name === "vite-hub" ? name : `@vite-hub/${name}`
    const { version } = JSON.parse(await readFile(join(repoRoot, "packages", name, "package.json"), "utf8"))
    run("pnpm", ["--filter", packageName, "pack", "--pack-destination", packDir])
    const tarball = join(packDir, `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`)
    if (!existsSync(tarball)) throw new Error(`Missing tarball ${tarball}. Run \`vp run build\` first.`)
    specs[packageName] = `file:${tarball}`
  }
  return specs
}

async function buildApp(workDir, backends) {
  const appDir = join(workDir, "app")
  const packDir = join(workDir, "packs")
  await mkdir(packDir, { recursive: true })
  const specs = await packWorkspace(packDir)
  await cp(join(here, "app"), appDir, { recursive: true })
  const featurePackages = Object.fromEntries(Object.entries(specs).filter(([name]) => fixturePackages.includes(name.replace("@vite-hub/", ""))))
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({
    dependencies: { ...appDependencies, ...featurePackages },
    packageManager: "pnpm@10.33.0",
    private: true,
    type: "module",
  }, null, 2)}\n`)
  const overrides = Object.entries({ ...specs, ...appOverrides })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)
  await writeFile(join(appDir, "pnpm-workspace.yaml"), [
    "packages:",
    "  - .",
    "allowBuilds:",
    "  esbuild: true",
    "  msgpackr-extract: false",
    "blockExoticSubdeps: false",
    "overrides:",
    ...overrides,
    "",
  ].join("\n"))
  run("pnpm", ["install", "--no-hoist", "--no-strict-peer-dependencies"], { cwd: appDir, logFile: join(workDir, "install.log") })
  // The build reads the same backend URLs as the instances, as a deployment does.
  run("pnpm", ["exec", "nuxt", "build"], {
    cwd: appDir,
    env: {
      DATABASE_URL: backends.databaseUrl,
      MULTI_INSTANCE_SHARED_BLOB_DIR: join(workDir, "shared-blob"),
      NUXT_TELEMETRY_DISABLED: "1",
      ...backends.redisEnv,
    },
    logFile: join(workDir, "build.log"),
  })
  return appDir
}

/** Starts one instance. Each instance has its own working directory, as on its own host. */
async function startInstance(name, appDir, workDir, backends) {
  const port = await freePort()
  // Start from an empty directory, so a rerun with --app does not see the stores of an earlier run.
  const cwd = join(workDir, `instance-${name}`)
  await rm(cwd, { force: true, recursive: true })
  await mkdir(cwd, { recursive: true })
  const logPath = join(workDir, `instance-${name}.log`)
  const logStream = createWriteStream(logPath)
  const child = spawn(process.execPath, [join(appDir, ".output/server/index.mjs")], {
    cwd,
    env: {
      ...baseEnv,
      DATABASE_URL: backends.databaseUrl,
      HOST: "127.0.0.1",
      MULTI_INSTANCE_NAME: name,
      MULTI_INSTANCE_ORACLE_URL: backends.databaseUrl,
      NODE_ENV: "production",
      PORT: String(port),
      ...backends.redisEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output += String(chunk)
      logStream.write(chunk)
    })
  }
  const instance = {
    child,
    logPath,
    logs: () => output,
    name,
    origin: `http://127.0.0.1:${port}`,
    port,
  }
  cleanups.push(() => stopInstance(instance))
  return instance
}

async function stopInstance(instance) {
  const { child } = instance
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const exited = once(child, "exit")
  const timeout = sleep(5000).then(() => "timeout")
  if (await Promise.race([exited, timeout]) === "timeout") {
    child.kill("SIGKILL")
    await exited
  }
}

async function waitForInstance(instance, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) {
      return { error: `exited with code ${instance.child.exitCode}\n${instance.logs().slice(-2000)}`, ok: false }
    }
    try {
      const response = await fetch(`${instance.origin}/api/health`)
      if (response.ok) return { ok: true }
    }
    catch {}
    await sleep(200)
  }
  return { error: `did not answer /api/health in ${timeoutMs} ms\n${instance.logs().slice(-2000)}`, ok: false }
}

async function cleanup() {
  while (cleanups.length) {
    try {
      await cleanups.pop()()
    }
    catch (error) {
      console.error(`[multi-instance] cleanup failed: ${error.message}`)
    }
  }
}

function printTable(results) {
  const rows = results.map(result => [
    result.id,
    result.status === "pass" ? "pass" : "FAIL",
    flaky[result.id] ? "flaky" : knownFailing[result.id] ? "yes" : "no",
    result.detail.split("\n")[0].slice(0, 110),
  ])
  const header = ["check", "result", "known failing", "detail"]
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)))
  const line = row => `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`
  console.log([line(header), line(widths.map(width => "-".repeat(width))), ...rows.map(line)].join("\n"))
}

async function main() {
  const workDir = options.app ? resolve(options.app, "..") : await mkdtemp(join(tmpdir(), "vitehub-multi-instance-"))
  if (!options.keep && !options.app) cleanups.push(() => rm(workDir, { force: true, recursive: true }))
  log(`work directory: ${workDir}`)
  log(`mode: ${mode}`)
  if (options.app) log("--app reuses a build. Build it in the same mode, because the build reads REDIS_URL.")

  const backends = await startBackends(`vitehub-multi-instance-${process.pid}`)
  const appDir = options.app ? resolve(options.app) : await buildApp(workDir, backends)
  const appRequire = createRequire(join(appDir, "package.json"))

  // The oracle table records what the fixture did. The fixture writes to it with its own client.
  const sql = appRequire("postgres")(backends.databaseUrl, { max: 2, onnotice: () => {} })
  cleanups.push(() => sql.end({ timeout: 5 }))
  await sql`create table oracle_events (id serial primary key, kind text not null, key text not null, instance text not null, at timestamptz not null default now())`

  // Start the three instances together, so their cold starts race as in a rolling deploy.
  const startedAt = Date.now()
  const instances = await Promise.all(instanceNames.map(name => startInstance(name, appDir, workDir, backends)))
  const boot = await Promise.all(instances.map(instance => waitForInstance(instance)))

  const context = {
    appDir,
    appRequire,
    backends,
    boot,
    instances,
    mode,
    sql,
    startedAt,
    stop: name => stopInstance(instances.find(instance => instance.name === name)),
    workDir,
  }
  const selected = options.only ? checks.filter(check => options.only.split(",").includes(check.id)) : checks
  const results = []
  for (const check of selected) {
    log(`check ${check.id}: ${check.title}`)
    const started = Date.now()
    let result
    try {
      result = await check.run(context)
    }
    catch (error) {
      result = { detail: error instanceof Error ? error.message : String(error), status: "fail" }
    }
    results.push({ ...result, id: check.id, ms: Date.now() - started })
    log(`check ${check.id}: ${result.status} (${Date.now() - started} ms) ${result.detail}`)
  }

  printTable(results)
  const unexpected = results.filter(result => result.status !== "pass" && !knownFailing[result.id] && !flaky[result.id])
  // A listed check that passes also fails the run, so the list stays exact.
  const fixed = results.filter(result => result.status === "pass" && knownFailing[result.id])
  if (unexpected.length) log(`unexpected failures: ${unexpected.map(result => result.id).join(", ")}`)
  if (fixed.length) log(`listed in known-failing.json "${mode}" but pass now, remove them: ${fixed.map(result => result.id).join(", ")}`)
  log(`logs: ${workDir}${options.keep ? "" : " (removed, use --keep to keep them)"}`)
  return unexpected.length || fixed.length ? 1 : 0
}

let exitCode = 1
process.once("SIGINT", () => cleanup().then(() => process.exit(130)))
process.once("SIGTERM", () => cleanup().then(() => process.exit(143)))
try {
  exitCode = await main()
}
catch (error) {
  console.error(error)
}
finally {
  await cleanup()
}
process.exit(exitCode)
