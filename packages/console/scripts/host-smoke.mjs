// Starts the Console build of one host on this machine and runs scripts/smoke.mjs against it. CI runs it for each host,
// so console.vitehub.dev and every self-hosted Console run the same checks on the same commit.
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
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { pathToFileURL } from "node:url"

import { smoke } from "./smoke.mjs"

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

function run(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, detached: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", chunk => output.push(chunk))
  child.stderr.on("data", chunk => output.push(chunk))
  children.push(child)
  return child
}

async function exec(command, args, env) {
  const child = run(command, args, env)
  const code = await new Promise(done => child.on("exit", done))
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${code}`)
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

// Each host returns its extra checks, which run after the shared smoke.
const hosts = {
  async node() {
    need(".output/server/index.mjs", "VITEHUB_HOST=node vp build")
    const dataDir = resolve(root, process.env.VITEHUB_DATA_DIR ?? ".data")
    await ready(run(process.execPath, [".output/server/index.mjs"], { ...secrets, HOST: "127.0.0.1", PORT: String(port) }))
    // The Dockerfile mounts only the data folder, so a database outside it is lost with the container.
    return [["keeps SQLite in the data folder", () => {
      if (!existsSync(join(dataDir, "database/sqlite.db"))) throw new Error(`${join(dataDir, "database/sqlite.db")} does not exist`)
    }]]
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
    await ready(run(wrangler, [
      "dev", "--config", config, "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state,
      "--compatibility-date", date, "--show-interactive-dev-session=false",
      ...Object.entries(secrets).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
    ]))
    return []
  },
  async vercel() {
    need(".vercel/output/functions/__server.func/index.mjs", "VITEHUB_HOST=vercel vp build")
    // The deploy steps of the README: migrate the hosted libSQL database, then deploy the prebuilt output.
    const database = { TURSO_DATABASE_URL: pathToFileURL(join(temp, "console.db")).href, TURSO_AUTH_TOKEN: "" }
    await exec(vitehub, ["database", "migrate"], { ...database, VITEHUB_HOST: "vercel" })
    Object.assign(process.env, secrets, database)
    await serveVercel(resolve(root, ".vercel/output"))
    await ready()
    return []
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
  console.error(`Usage: node scripts/host-smoke.mjs <${Object.keys(hosts).join("|")}>`)
  process.exit(2)
}

let failures = []
try {
  console.log(`Console on ${host} at ${base}`)
  const extra = await hosts[host]()
  failures = await smoke(base)
  for (const [name, check] of extra) {
    try {
      await check()
      console.log(`ok    ${name}`)
    }
    catch (error) {
      failures.push(name)
      console.log(`FAIL  ${name}: ${error.message}`)
    }
  }
}
catch (error) {
  failures.push(String(error.message ?? error))
  console.error(error.message ?? error)
}
finally {
  stop()
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed on ${host}. Server output:\n${Buffer.concat(output.map(chunk => Buffer.from(chunk))).toString().slice(-6000)}`)
  process.exitCode = 1
}
else console.log(`\nAll checks passed on ${host}.`)
// The Vercel function keeps timers and connections open in this process.
process.exit()
