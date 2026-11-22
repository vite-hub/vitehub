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

async function halt(child) {
  const exited = child.exitCode === null && child.signalCode === null ? new Promise(done => child.once("exit", done)) : undefined
  const signal = (name) => {
    try {
      process.kill(-child.pid, name)
    }
    catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }
  if (exited) {
    signal("SIGTERM")
    const timeout = Symbol("timeout")
    if (await Promise.race([exited, new Promise(done => setTimeout(done, 15_000, timeout))]) === timeout) {
      signal("SIGKILL")
      await exited
    }
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

const hosts = {
  async node() {
    need(".output/server/index.mjs", "VITEHUB_HOST=node vp build")
    const dataDir = resolve(root, process.env.VITEHUB_DATA_DIR ?? ".data")
    const database = join(dataDir, "database/sqlite.db")
    return {
      async start(vars) {
        const child = run(process.execPath, [".output/server/index.mjs"], { ...secrets, ...vars, HOST: "127.0.0.1", PORT: String(port) })
        await ready(child)
        return () => halt(child)
      },
      sql: sqlite(database),
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
    const file = join(temp, "console.db")
    const database = { TURSO_DATABASE_URL: pathToFileURL(file).href, TURSO_AUTH_TOKEN: "" }
    await exec(vitehub, ["database", "migrate"], { ...database, VITEHUB_HOST: "vercel" })
    Object.assign(process.env, secrets, database)
    await serveVercel(resolve(root, ".vercel/output"))
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

function workerdCompatibilityDate() {
  try {
    const fromWrangler = createRequire(realpathSync(resolve(root, "../../node_modules/wrangler/package.json")))
    const fromMiniflare = createRequire(fromWrangler.resolve("miniflare"))
    return fromMiniflare("workerd").compatibilityDate
  }
  catch {
    return undefined
  }
}

const types = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff2": "font/woff2" }

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
process.exit()
