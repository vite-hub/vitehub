// Starts the Console build of one host on this machine and runs scripts/smoke.mjs and scripts/env-smoke.mjs against it.
// CI runs it for each host, so console.vitehub.dev and every self-hosted Console run the same checks on the same commit.
//
// The build starts three times on one database: with env values off, as console.vitehub.dev runs, then with values on,
// then with values on and another key.
//
//   VITEHUB_HOST=<host> vp build && node scripts/host-smoke.mjs <host>
//
// node:       `node .output/server/index.mjs` with SQLite in VITEHUB_DATA_DIR (default .data), as in the Dockerfile.
// cloudflare: `wrangler d1 migrations apply --local`, then `wrangler dev` with a local D1.
// vercel:     `vitehub database migrate` on a file: libSQL URL, then the Vercel function behind a static file server.
//
// Build the Console page first (`vp run --filter vite-hub build:console-account`), or the smoke fails on the placeholder.
// PORT picks the port, 3000 by default.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { pathToFileURL } from "node:url"
import { format } from "node:util"

import { envKey, envOffChecks, envOnChecks, envOtherKeyChecks, seedOwner } from "./env-smoke.mjs"
import { runChecks, smoke } from "./smoke.mjs"

const root = resolve(import.meta.dirname, "..")
const wrangler = resolve(root, "../../node_modules/.bin/wrangler")
const vitehub = resolve(root, "node_modules/.bin/vitehub")
const host = process.argv[2]
const port = Number(process.env.PORT ?? 3000)
const base = `http://127.0.0.1:${port}`
const secrets = { BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), VITEHUB_CONSOLE_SECRET: randomBytes(32).toString("hex") }
const temp = mkdtempSync(join(tmpdir(), `vitehub-console-${host}-`))
const children = []
const output = []
// The Vercel function runs in this process and logs with `console`, so the smoke prints with these instead.
const print = text => process.stdout.write(`${text}\n`)
const printError = text => process.stderr.write(`${text}\n`)

function run(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, detached: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", chunk => output.push(chunk))
  child.stderr.on("data", chunk => output.push(chunk))
  children.push(child)
  return child
}

async function exec(command, args, env) {
  const child = run(command, args, env)
  const stdout = []
  child.stdout.on("data", chunk => stdout.push(chunk))
  const code = await new Promise(done => child.on("exit", done))
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${code}`)
  return Buffer.concat(stdout).toString()
}

/** Stop a server that `run()` started, and wait until its port is free, so the next start answers on it. */
async function halt(child) {
  if (child.exitCode === null) {
    const exited = new Promise(done => child.on("exit", done))
    process.kill(-child.pid, "SIGTERM")
    await Promise.race([exited, new Promise(done => setTimeout(done, 15_000))])
    if (child.exitCode === null) process.kill(-child.pid, "SIGKILL")
  }
  for (let tries = 0; tries < 60; tries++) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(1_000) })
      await new Promise(done => setTimeout(done, 500))
    }
    catch {
      return
    }
  }
  throw new Error(`${base} still answers after the server stopped`)
}

/** Run SQL on a SQLite or file: libSQL database. Returns the rows of a SELECT. */
function sqlite(file) {
  return (text) => {
    const db = new DatabaseSync(file, { timeout: 10_000 })
    try {
      if (/^\s*select/i.test(text)) return db.prepare(text).all()
      db.exec(text)
      return []
    }
    finally {
      db.close()
    }
  }
}

async function ready(child) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`The server exited with ${child.exitCode} before it answered`)
    try {
      await fetch(base, { signal: AbortSignal.timeout(5_000) })
      return
    }
    catch {
      await new Promise(done => setTimeout(done, 500))
    }
  }
  throw new Error(`${base} did not answer within 2 minutes`)
}

function need(path, build) {
  if (!existsSync(resolve(root, path))) throw new Error(`${path} is missing. Build it first: ${build}`)
}

// Each host has `start(vars)`, which starts the build with extra variables and returns its stop function, `sql(text)` on
// the database of the build, and `extra` checks, which run after the shared smoke.
const hosts = {
  async node() {
    need(".output/server/index.mjs", "VITEHUB_HOST=node vp build")
    const dataDir = resolve(root, process.env.VITEHUB_DATA_DIR ?? ".data")
    const database = join(dataDir, "database/sqlite.db")
    return {
      // The server applies the migrations when it starts.
      async start(vars) {
        const child = run(process.execPath, [".output/server/index.mjs"], { ...secrets, ...vars, HOST: "127.0.0.1", PORT: String(port) })
        await ready(child)
        return () => halt(child)
      },
      sql: sqlite(database),
      // The Dockerfile mounts only the data folder, so a database outside it is lost with the container.
      extra: [["keeps SQLite in the data folder", () => {
        if (!existsSync(database)) throw new Error(`${database} does not exist`)
      }]],
    }
  },
  async cloudflare() {
    need(".output/server/wrangler.json", "VITEHUB_HOST=cloudflare vp build")
    const config = ".output/server/wrangler.json"
    const state = join(temp, "wrangler")
    await exec(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", state])
    // The build sets the build date as the compatibility date. The local workerd may not know that date yet, so run with
    // the newest date that it supports when the build date is newer.
    const built = JSON.parse(readFileSync(resolve(root, config), "utf8")).compatibility_date
    const supported = workerdCompatibilityDate()
    const date = supported && supported < built ? supported : built
    return {
      async start(vars) {
        const child = run(wrangler, [
          "dev", "--config", config, "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state,
          "--compatibility-date", date, "--show-interactive-dev-session=false",
          ...Object.entries({ ...secrets, ...vars }).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
        ])
        await ready(child)
        return () => halt(child)
      },
      // The local D1 of `wrangler dev`, the same SQLite file that the Worker uses.
      async sql(text) {
        const out = await exec(wrangler, ["d1", "execute", "DB", "--local", "--config", config, "--persist-to", state, "--json", "--command", text])
        const results = JSON.parse(out.slice(out.indexOf("[")))
        return results.at(-1)?.results ?? []
      },
      extra: [],
    }
  },
  async vercel() {
    need(".vercel/output/functions/__server.func/index.mjs", "VITEHUB_HOST=vercel vp build")
    // The deploy steps of the README: migrate the hosted libSQL database, then deploy the prebuilt output.
    const file = join(temp, "console.db")
    const database = { TURSO_DATABASE_URL: pathToFileURL(file).href, TURSO_AUTH_TOKEN: "" }
    await exec(vitehub, ["database", "migrate"], { ...database, VITEHUB_HOST: "vercel" })
    Object.assign(process.env, secrets, database)
    // The function runs in this process and reads process.env on each request, so a new start sets other variables.
    await serveVercel(resolve(root, ".vercel/output"))
    // Its logs go with the server output, which the smoke prints when a check fails.
    for (const level of ["debug", "error", "info", "log", "warn"]) console[level] = (...args) => output.push(Buffer.from(`${format(...args)}\n`))
    return {
      async start(vars) {
        Object.assign(process.env, vars)
        await ready()
        return () => {
          for (const name of Object.keys(vars)) delete process.env[name]
        }
      },
      sql: sqlite(file),
      extra: [],
    }
  },
}

/** The newest compatibility date of the workerd that Wrangler runs. */
function workerdCompatibilityDate() {
  try {
    // pnpm links node_modules/wrangler into its store, where Wrangler's own dependencies live.
    const fromWrangler = createRequire(realpathSync(resolve(root, "../../node_modules/wrangler/package.json")))
    const fromMiniflare = createRequire(fromWrangler.resolve("miniflare"))
    return fromMiniflare("workerd").compatibilityDate
  }
  catch {
    return undefined
  }
}

const types = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff2": "font/woff2" }

/**
 * Vercel serves a file of `static/` first and sends other paths to the function (`{ "handle": "filesystem" }` in
 * config.json). Every route of the Console goes to the same `__server` function.
 */
async function serveVercel(dir) {
  const handler = (await import(pathToFileURL(join(dir, "functions/__server.func/index.mjs")).href)).default
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base)
      const file = join(dir, "static", decodeURIComponent(url.pathname))
      if ((req.method === "GET" || req.method === "HEAD") && file.startsWith(join(dir, "static")) && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
        res.end(req.method === "HEAD" ? undefined : readFileSync(file))
        return
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req)
      const headers = new Headers(Object.entries(req.headers).flatMap(([name, value]) => [value].flat().map(item => [name, item])))
      // Vercel sets the client address on every request.
      headers.set("x-forwarded-for", req.socket.remoteAddress)
      headers.set("x-real-ip", req.socket.remoteAddress)
      const request = new Request(url, { method: req.method, headers, body, duplex: "half" })
      const response = await handler.fetch(request, {})
      res.writeHead(response.status, [...response.headers].flat())
      if (response.body) await pipeline(Readable.fromWeb(response.body), res)
      else res.end()
    }
    catch (error) {
      output.push(Buffer.from(`${error?.stack ?? error}\n`))
      res.writeHead(500).end(String(error?.stack ?? error))
    }
  })
  await new Promise(done => server.listen(port, "127.0.0.1", done))
  children.push({ kill: () => server.close() })
}

function stop() {
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM")
      else child.kill()
    }
    catch {}
  }
  rmSync(temp, { force: true, recursive: true })
}

if (!Object.hasOwn(hosts, host)) {
  printError(`Usage: node scripts/host-smoke.mjs <${Object.keys(hosts).join("|")}>`)
  process.exit(2)
}

let failures = []
try {
  print(`Console on ${host} at ${base}`)
  const server = await hosts[host]()
  // Off is the config of console.vitehub.dev.
  let stopServer = await server.start({})
  failures = await smoke(base, print)
  failures.push(...await runChecks(server.extra, [], print))
  const ctx = await seedOwner(server.sql)
  print("\nEnv values off")
  failures.push(...await runChecks(envOffChecks, [base, ctx], print))
  await stopServer()
  print("\nEnv values on")
  stopServer = await server.start({ VITEHUB_CONSOLE_ENV_KEY: envKey(), VITEHUB_CONSOLE_ENV_VALUES: "1" })
  failures.push(...await runChecks(envOnChecks, [base, ctx, server.sql], print))
  await stopServer()
  print("\nEnv values on, with another key")
  stopServer = await server.start({ VITEHUB_CONSOLE_ENV_KEY: envKey(), VITEHUB_CONSOLE_ENV_VALUES: "1" })
  failures.push(...await runChecks(envOtherKeyChecks, [base, ctx], print))
  await stopServer()
}
catch (error) {
  failures.push(String(error.message ?? error))
  printError(error.message ?? error)
}
finally {
  stop()
}
if (failures.length) {
  printError(`\n${failures.length} check(s) failed on ${host}. Server output:\n${Buffer.concat(output.map(chunk => Buffer.from(chunk))).toString().slice(-6000)}`)
  process.exitCode = 1
}
else print(`\nAll checks passed on ${host}.`)
// The Vercel function keeps timers and connections open in this process.
process.exit()
