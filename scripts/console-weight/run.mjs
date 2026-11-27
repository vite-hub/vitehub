import { spawn, spawnSync } from "node:child_process"
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"

import { createConsoleKeyPair, signConsoleRequest } from "@vite-hub/internal/console-signature"
import { providerHosts } from "@vite-hub/internal/deployment"

import { chunkGrowth } from "./chunk-growth.mjs"
import { memoryBudget, memoryNoiseLimit, memoryVerdict } from "./memory-verdict.mjs"
import { startupGrowth } from "./startup-growth.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../..")
const fixture = join(here, "fixture")
const publicUrl = "https://console-weight.example.com"
const keyName = "WEIGHT"
const kB = 1000
const MB = 1000 * 1000
const memoryRounds = 7
const settleMs = 3000
const httpTimeoutMs = 60_000
const ownerNoise = 1000
const hosts = ["cloudflare", "node"]
const authModes = ["off", "on"]
const primitives = ["agent", "auth", "blob", "browser", "channels", "cms", "comments", "connections", "content", "database", "email", "forge", "forms", "gateways", "i18n", "kv", "mcp", "queue", "rate-limit", "realtime", "sandbox", "schedule", "source", "sync", "webhooks", "workflow", "workspace"]
const configuredPrimitives = auth => ["agent", "kv", "database", ...auth === "on" ? ["auth"] : []]

const consoleSources = [
  "packages/vite-hub/src/console/",
  "packages/internal/src/console.ts",
  "packages/internal/src/console-signature.ts",
  "packages/internal/src/operation-registry.ts",
  "packages/internal/src/operation-rpc.ts",
  "packages/runtime/src/internal/console.ts",
  "<app>/.vitehub/nitro/console/",
]
const consoleOnlyAuthColumns = ["user.role"]
const operationMissing = "Console operation not found."
const retainedOperations = auth => ["project.get", "logs.list", "agents.list", "invocations.list", "invocations.get", "databases.tables", "databases.browse", "kv.set", "kv.get", "kv.list", ...auth === "on" ? ["auth.users", "auth.sessions"] : []]
const absent = "console-weight-missing"
const agent = "hello"
const invocationFailures = ["VITE_HUB_C0001", "VITE_HUB_R0046"]
const channelFailures = ["AGENT_CHANNELS_NOT_FOUND", "AGENT_CHANNELS_NO_STATUS", "CONSOLE_NOT_FOUND"]
const authFailures = ["AUTH_CONSOLE_FORBIDDEN", "AUTH_CONSOLE_NOT_FOUND", "CONSOLE_NOT_FOUND"]
const sectionFailures = ["CONSOLE_NOT_FOUND"]
const operationProbes = [
  ["project.get", {}, [], (value, state) => {
    if (!Array.isArray(value?.operations) || !value.operations.every(name => typeof name === "string")) return "no operations array"
    state.exposed = value.operations
  }],
  ["sections.list", {}],
  ["agents.list", {}],
  ["status.get", { agent }],
  ["skills.inspect", { agent }],
  ["agents.invoke", { agent, prompt: "Hello" }, ["VITE_HUB_R0046"]],
  ["definitions.list", { section: "databases" }],
  ["invocations.list", { agent }, [], (value, state) => {
    state.invocation = value?.invocations?.[0]?.id
    return state.invocation ? undefined : "no invocation after the Agent run"
  }],
  ["invocations.capabilities", { agent }],
  ["invocations.get", state => ({ id: state.invocation ?? absent })],
  ["invocations.workspace", state => ({ id: state.invocation ?? absent }), invocationFailures],
  ["invocations.cancel", state => ({ id: state.invocation ?? absent }), invocationFailures],
  ["invocations.undo", state => ({ change: absent, id: state.invocation ?? absent }), invocationFailures],
  ["conversations.export", { agent, channel: absent, thread: absent }, channelFailures],
  ["invocations.usage", {}],
  ["search.query", { search: "hello" }],
  ["env.get", {}],
  ["env.inspect", {}],
  ["durability.list", {}],
  ["logs.list", {}],
  ["databases.tables", {}],
  ["databases.browse", { table: "notes" }],
  ["kv.set", { key: "console-weight", value: 1 }],
  ["kv.get", { key: "console-weight" }],
  ["kv.has", { key: "console-weight" }],
  ["kv.list", {}],
  ["kv.delete", { key: "console-weight" }],
  ["channels.list", {}],
  ["channels.status", { agent, channel: absent }, channelFailures],
  ["channels.threads", { agent, channel: absent }, channelFailures],
  ["channels.deliveries", { agent, channel: absent }, channelFailures],
  ["channels.conversation", { agent, channel: absent, thread: absent }, channelFailures],
  ["channels.replay", { agent, channel: absent, describe: true }, channelFailures],
  ["workspaces.files", { name: absent }, sectionFailures],
  ["documents.action", { action: "list", section: "content" }, sectionFailures],
  ["documents.preview", { collection: absent, id: absent, section: "content" }, sectionFailures],
  ["media.action", { action: "list", section: "content" }, sectionFailures],
  ["media.upload", { data: "", filename: "console-weight.txt", section: "content" }, sectionFailures],
  ["site.access", {}],
  ["site.grants", {}],
  ["site.sessions", {}, [], (value, state) => {
    state.sessionsBefore = Array.isArray(value?.sessions) ? value.sessions.length : undefined
  }],
  ["site.link", { path: "/" }, [], (value, state) => {
    state.ticket = value?.url
    return typeof value?.url === "string" ? undefined : "no ticket URL"
  }],
  ["site.invite", { grants: ["console"], name: "Console weight" }, ["CONSOLE_REQUEST_INVALID"]],
  ["site.invites", {}],
  ["auth.describe", {}, authFailures],
  ["auth.overview", {}, authFailures],
  ["auth.activity", {}, authFailures],
  ["auth.users", {}, authFailures],
  ["auth.user", { id: absent }, authFailures],
  ["auth.sessions", {}, authFailures],
  ["auth.organizations", {}, authFailures],
  ["auth.organization", { id: absent }, authFailures],
  ["auth.agents", {}, authFailures],
  ["auth.ban", { userId: absent }, authFailures],
  ["auth.unban", { userId: absent }, authFailures],
  ["auth.set-role", { role: "member", userId: absent }, authFailures],
  ["auth.edit-field", { field: "name", userId: absent, value: "Console weight" }, authFailures],
  ["auth.revoke-sessions", { userId: absent }, authFailures],
  ["auth.revoke-session", { id: absent }, authFailures],
  ["auth.revoke-consent", { id: absent }, authFailures],
  ["auth.remove", { userId: absent }, authFailures],
  ["auth.impersonate", { userId: absent }, authFailures],
  ["auth.stop-impersonating", {}, authFailures],
  ["site.revoke-invite", { id: absent }, sectionFailures],
  ["site.revoke-session", state => ({ id: state.session ?? absent })],
  ["invocations.delete", state => ({ id: state.invocation ?? absent }), invocationFailures],
]
const caller = { via: "console", user: { id: "console-weight", name: "Console weight", email: "weight@example.com", emailVerified: true }, team: { id: "console-weight", role: "owner" } }

function parseArgs(argv) {
  const options = { json: undefined, keep: false, work: tmpdir() }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === "--json") {
      options.json = next && !next.startsWith("--") ? resolve(argv[++index]) : "-"
    }
    else if (arg.startsWith("--json=")) options.json = resolve(arg.slice("--json=".length))
    else if (arg === "--work" && next) options.work = resolve(argv[++index])
    else if (arg === "--keep") options.keep = true
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node scripts/console-weight/run.mjs [--json [file]] [--work <parent dir>] [--keep]\nBuilds the fixture app with the Console off and on, on Cloudflare and Node, with and without Auth, and compares them. Each run builds in a new folder under --work (default: the OS temp folder) and removes it at the end unless --keep is set or a step fails. Run `vp run build` first.\n")
      process.exit(0)
    }
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const log = options.json === "-" ? message => process.stderr.write(`${message}\n`) : message => process.stdout.write(`${message}\n`)

function walk(directory, skip = () => false) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (skip(path)) return []
    return entry.isDirectory() ? walk(path, skip) : [path]
  })
}

const isSourceMap = path => path.endsWith(".map")
const isCode = path => /\.m?js$/.test(path)

function codeText(file) {
  return readFileSync(file, "utf8").replace(/\n\/\/# sourceMappingURL=[^\n]*\n?$/, "\n")
}

function fileBytes(file) {
  return isCode(file) ? Buffer.from(codeText(file)) : readFileSync(file)
}

function sizes(files) {
  let raw = 0
  let gzip = 0
  for (const file of files.filter(path => !isSourceMap(path))) {
    const bytes = fileBytes(file)
    raw += bytes.length
    gzip += gzipSync(bytes, { level: 9 }).length
  }
  return { files: files.filter(path => !isSourceMap(path)).length, raw, gzip }
}

function run(command, args, settings) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: settings.cwd, env: settings.env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", chunk => output += chunk)
    child.stderr.on("data", chunk => output += chunk)
    child.on("close", code => done({ code, output }))
  })
}

function fail(message) {
  process.stderr.write(`[console-weight] ${message}\n`)
  process.exit(2)
}

function variantName(host, auth) {
  return auth === "on" ? `${host} + Auth` : host
}

async function buildApp(runDirectory, host, auth, consoleMode) {
  const app = join(runDirectory, `${host}-auth-${auth}-console-${consoleMode}`)
  cpSync(fixture, app, { recursive: true, filter: source => !source.startsWith(join(fixture, "auth")) })
  if (auth === "on") cpSync(join(fixture, "auth/auth.ts"), join(app, "server/auth.ts"))
  symlinkSync(join(repo, "node_modules"), join(app, "node_modules"), "dir")
  const env = { ...process.env, CI: "1", CONSOLE_WEIGHT_AUTH: auth, CONSOLE_WEIGHT_CONSOLE: consoleMode, CONSOLE_WEIGHT_HOST: host }
  for (const name of ["VITEHUB_HOST", "VITEHUB_HOST_SOURCE", "NITRO_PRESET", "SERVER_PRESET", ...providerHosts.map(([name]) => name)]) delete env[name]
  const steps = [["vitehub", ["database", "generate"]], ["vp", ["build"]]]
  for (const [bin, args] of steps) {
    const started = Date.now()
    const result = await run(join(repo, "node_modules/.bin", bin), args, { cwd: app, env })
    writeFileSync(join(app, `${bin}-${args.at(-1)}.log`), result.output)
    if (result.code !== 0) fail(`${bin} ${args.join(" ")} failed in ${app} (exit ${result.code}). Log: ${join(app, `${bin}-${args.at(-1)}.log`)}\n${result.output.slice(-3000)}`)
    log(`  ${variantName(host, auth)}, Console ${consoleMode}: ${bin} ${args.join(" ")} ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
  return app
}

const importPattern = /(?:^|[\n;}])\s*(?:import|export)\s*(?:[^'";]*?from\s*)?["'](\.{1,2}\/[^"']+)["']/g

function startupGraph(server) {
  const seen = new Set()
  const stack = [join(server, "index.mjs")]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, "utf8").matchAll(importPattern)) stack.push(resolve(dirname(file), match[1]))
  }
  const files = [...seen]
  return { ...sizes(files), modules: files.map(file => relative(server, file)).sort() }
}

const base64Digits = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((char, index) => [char, index]))

function decodeMappings(mappings) {
  return mappings.split(";").map(line => line.split(",").filter(Boolean).map((segment) => {
    const values = []
    let value = 0
    let shift = 0
    for (const char of segment) {
      const digit = base64Digits[char]
      value += (digit & 31) * 2 ** shift
      if (digit & 32) shift += 5
      else {
        values.push(value % 2 ? -Math.floor(value / 2) : value / 2)
        value = 0
        shift = 0
      }
    }
    return values
  }))
}

function realPath(path) {
  try {
    return realpathSync(path)
  }
  catch {
    return path
  }
}

const distRegionCache = new Map()

function distRegions(file) {
  if (distRegionCache.has(file)) return distRegionCache.get(file)
  let regions
  const marker = file.lastIndexOf("/dist/")
  if (marker !== -1 && existsSync(file)) {
    const packageRoot = file.slice(0, marker)
    const lines = readFileSync(file, "utf8").split("\n")
    regions = []
    let open
    lines.forEach((line, index) => {
      const mark = line.match(/^\/\/#region (.+)$/)
      if (mark) {
        open = { start: index, end: lines.length - 1, path: resolve(packageRoot, mark[1]) }
        regions.push(open)
      }
      else if (open && line.startsWith("//#endregion")) {
        open.end = index
        open = undefined
      }
    })
  }
  distRegionCache.set(file, regions)
  return regions
}

function sourceAtLine(file, line) {
  const regions = distRegions(file)
  if (!regions?.length) return file
  return regions.find(region => line >= region.start && line <= region.end)?.path ?? file
}

function isVirtual(path) {
  return path.startsWith("virtual:") || path.startsWith("\0") || path.startsWith("#")
}

function isConsoleSource(path, app) {
  if (isVirtual(path)) return /vitehub[/-]console/.test(path)
  return consoleSources.some((pattern) => {
    const absolute = pattern.startsWith("<app>/") ? join(app, pattern.slice("<app>/".length)) : join(repo, pattern)
    return pattern.endsWith("/") ? path.startsWith(absolute) : path === absolute
  })
}

function ownerOf(path, app) {
  if (isVirtual(path)) return "virtual"
  const modules = path.lastIndexOf("/node_modules/")
  if (modules !== -1) {
    const parts = path.slice(modules + "/node_modules/".length).split("/")
    return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
  }
  const inApp = relative(app, path)
  if (!inApp.startsWith("..")) {
    const generated = inApp.match(/^\.vitehub\/(?:nitro\/)?([^/.]+)/)
    return generated ? generated[1] : "app"
  }
  const inRepo = relative(repo, path)
  const pkg = inRepo.match(/^packages\/([^/]+)\/(src|dist)\/([^/]+)/)
  if (!pkg) return inRepo.startsWith("..") ? "other" : inRepo.split("/")[0]
  if (pkg[1] === "vite-hub" && pkg[2] === "src") return pkg[3].replace(/\.[cm]?[jt]s$/, "")
  return pkg[1]
}

function sourceKey(path, app) {
  if (isVirtual(path)) return path
  const modules = path.lastIndexOf("/node_modules/")
  if (modules !== -1) return `node_modules/${path.slice(modules + "/node_modules/".length)}`
  const inApp = relative(app, path)
  return inApp.startsWith("..") ? relative(repo, path) : `<app>/${inApp}`
}

function isLinkage(line) {
  return /^\s*(?:\/\/|\/\*|\*)/.test(line) || /^(?:import|export)\b[^;]*(?:from\s*)?["'][^"']+["'];?\s*$/.test(line) || /^export \{[^}]*\};?$/.test(line)
}

function serverCodeFiles(app) {
  return walk(join(app, ".output/server"), path => path.includes("/node_modules")).filter(isCode)
}

function attribute(app) {
  const facts = new Map()
  const factOf = (path) => {
    if (!facts.has(path)) facts.set(path, { owner: ownerOf(path, app), console: isConsoleSource(path, app) })
    return facts.get(path)
  }
  const regionFallback = new Map()
  const fallbackOf = (id) => {
    if (regionFallback.has(id)) return regionFallback.get(id)
    const path = isVirtual(id) ? id : realPath(resolve(app, id))
    const regions = isVirtual(path) ? undefined : distRegions(path)
    let fallback = path
    if (regions?.length) {
      const kinds = new Set(regions.map(region => `${factOf(region.path).owner}:${factOf(region.path).console}`))
      fallback = kinds.size === 1 ? regions[0].path : undefined
    }
    regionFallback.set(id, fallback)
    return fallback
  }
  const chunks = {}
  let glueRaw = 0
  let glueGzip = 0
  const envLiterals = new Set()
  let total = 0
  let unattributed = 0
  let linkage = 0
  const unattributedFiles = {}
  for (const file of serverCodeFiles(app)) {
    const lines = codeText(file).split("\n")
    const inLibs = relative(join(app, ".output/server"), file).startsWith("_libs/")
    const mapFile = `${file}.map`
    const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, "utf8")) : undefined
    const sources = map ? map.sources.map(source => isVirtual(source) ? source : realPath(resolve(dirname(file), map.sourceRoot ?? "", source))) : []
    const mappings = map ? decodeMappings(map.mappings) : []
    let sourceIndex = 0
    let originalLine = 0
    let region
    const chunkOwners = {}
    const chunkSources = {}
    let chunkUnmapped = 0
    const consolePieces = []
    lines.forEach((line, index) => {
      const text = index < lines.length - 1 ? `${line}\n` : line
      const mark = line.match(/^\/\/#region (.+)$/)
      if (mark) region = mark[1]
      const pieces = []
      let column = 0
      for (const values of mappings[index] ?? []) {
        column += values[0]
        if (values.length >= 4) {
          sourceIndex += values[1]
          originalLine += values[2]
          pieces.push({ column, path: sourceAtLine(sources[sourceIndex], originalLine) })
        }
        else pieces.push({ column, path: undefined })
      }
      if (!pieces.length || pieces[0].column > 0) pieces.unshift({ column: 0, path: undefined })
      pieces.forEach((piece, position) => {
        const slice = text.slice(piece.column, position + 1 < pieces.length ? pieces[position + 1].column : text.length)
        const bytes = Buffer.byteLength(slice)
        total += bytes
        const path = piece.path ?? (region ? fallbackOf(region) : inLibs ? join(app, "node_modules/_libs") : undefined)
        if (!path) {
          if (!/\S/.test(slice)) return
          chunkUnmapped += bytes
          if (isLinkage(line)) linkage += bytes
          else {
            unattributed += bytes
            const key = relative(join(app, ".output/server"), file)
            unattributedFiles[key] = (unattributedFiles[key] ?? 0) + bytes
          }
          return
        }
        const fact = factOf(path)
        chunkOwners[fact.owner] = (chunkOwners[fact.owner] ?? 0) + bytes
        if (piece.path || region) {
          const key = sourceKey(path, app)
          chunkSources[key] = (chunkSources[key] ?? 0) + bytes
        }
        else chunkUnmapped += bytes
        if (fact.console) consolePieces.push(slice)
      })
      if (line.startsWith("//#endregion")) region = undefined
    })
    const consoleCode = consolePieces.join("")
    glueRaw += Buffer.byteLength(consoleCode)
    if (consoleCode) glueGzip += gzipSync(consoleCode, { level: 9 }).length
    for (const match of consoleCode.matchAll(/["'`](VITEHUB_[A-Z0-9_]+)["'`]/g)) envLiterals.add(match[1])
    const body = lines.filter(line => !isLinkage(line)).join("\n")
    chunks[relative(join(app, ".output/server"), file)] = { owners: chunkOwners, sources: chunkSources, unmapped: chunkUnmapped, fingerprint: createHash("sha256").update(body).digest("hex") }
  }
  return {
    total,
    unattributed,
    linkage,
    unattributedFiles: Object.entries(unattributedFiles).sort((a, b) => b[1] - a[1]).slice(0, 10),
    chunks,
    glue: { raw: glueRaw, gzip: glueGzip, envLiterals: [...envLiterals].sort() },
  }
}

function declaredEnv(manifest) {
  const entries = Array.isArray(manifest?.env) ? manifest.env : []
  return entries.filter(entry => entry?.required === true).map((entry) => {
    const names = Array.isArray(entry.names) ? entry.names.filter(name => typeof name === "string") : []
    return (typeof entry.prefix === "string" ? [...names, `${entry.prefix}<NAME>`] : names).join(" | ")
  }).sort()
}

function authSchema(app) {
  const migrations = join(app, "server/databases/default/migrations")
  const sql = walk(migrations).filter(file => file.endsWith(".sql")).sort().map(file => readFileSync(file, "utf8")).join("\n--> statement-breakpoint\n")
  const statements = sql.split(/--> statement-breakpoint|;\s*\n/).map(statement => statement.replace(/\s+/g, " ").replace(/;\s*$/, "").trim()).filter(Boolean)
  const user = statements.find(statement => statement.startsWith("CREATE TABLE `user` ("))
  const userColumns = user ? [...user.matchAll(/[(,] `([^`]+)` /g)].map(match => `user.${match[1]}`) : []
  return { statements: [...new Set(statements)].sort(), hasUser: Boolean(user), userColumns }
}

function schemaDiff(off, on) {
  const shorten = statement => statement.length > 80 ? `${statement.slice(0, 77)}...` : statement
  return [
    ...on.statements.filter(statement => !off.statements.includes(statement)).map(statement => `+${shorten(statement)}`),
    ...off.statements.filter(statement => !on.statements.includes(statement)).map(statement => `-${shorten(statement)}`),
  ]
}

function startupSources(modules, chunks) {
  const sources = {}
  let unmapped = 0
  for (const module of modules) {
    const chunk = chunks[module]
    if (!chunk) continue
    unmapped += chunk.unmapped
    for (const [source, bytes] of Object.entries(chunk.sources)) sources[source] = (sources[source] ?? 0) + bytes
  }
  return { sources, unmapped, sourceBytes: Object.values(sources).reduce((total, bytes) => total + bytes, 0) }
}

function staticMeasures(app, host) {
  const manifest = JSON.parse(readFileSync(join(app, ".output/deployment.json"), "utf8"))
  if (manifest?.host !== host) fail(`Expected host ${host} in ${app}/.output/deployment.json, got ${manifest?.host ?? "no host"}.`)
  const server = join(app, ".output/server")
  const attribution = attribute(app)
  const startup = startupGraph(server)
  return {
    server: sizes(walk(server, path => path.includes("/node_modules"))),
    startup: { ...startup, ...startupSources(startup.modules, attribution.chunks) },
    publicFiles: walk(join(app, ".output/public/_vitehub")).filter(file => !isSourceMap(file)).map(file => relative(join(app, ".output/public"), file)).sort(),
    attribution,
    declaredEnv: declaredEnv(manifest),
    authSchema: authSchema(app),
  }
}

function freePort() {
  return new Promise((done, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => done(typeof address === "object" && address ? address.port : 0))
    })
  })
}

function sleep(ms) {
  return new Promise(done => setTimeout(done, ms))
}

function fetchProbe(url, options = {}) {
  return fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(httpTimeoutMs) })
}

const rssReporter = `data:text/javascript,${encodeURIComponent("process.on(\"message\", message => { if (message === \"rss\") process.send({ rss: process.memoryUsage().rss }) }); process.channel?.unref()")}`

async function startServer(app, env) {
  rmSync(join(app, ".vitehub/data"), { recursive: true, force: true })
  const port = await freePort()
  const child = spawn(process.execPath, [`--import=${rssReporter}`, ".output/server/index.mjs"], {
    cwd: app,
    env: { HOME: process.env.HOME, NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), NODE_ENV: "production", PATH: process.env.PATH, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  let output = ""
  child.stdout.on("data", chunk => output += chunk)
  child.stderr.on("data", chunk => output += chunk)
  let exited = false
  child.on("error", error => output += `\n${error.message}`)
  const exit = new Promise(done => child.once("close", () => {
    exited = true
    done()
  }))
  const base = `http://127.0.0.1:${port}`
  const stop = async () => {
    if (!exited) child.kill("SIGTERM")
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    try {
      await exit
    }
    finally {
      clearTimeout(killTimer)
    }
  }
  try {
    const deadline = Date.now() + httpTimeoutMs
    const signal = AbortSignal.timeout(httpTimeoutMs)
    for (;;) {
      if (exited) throw new Error(`The server in ${app} exited before it was ready.\n${output.slice(-3000)}`)
      const response = await fetchProbe(`${base}/api/touch`, { signal }).catch(() => undefined)
      if (response) {
        const body = await response.text()
        if (!response.ok) throw new Error(`GET /api/touch answered ${response.status} in ${app}: ${body.slice(0, 500)}\n${output.slice(-3000)}`)
        break
      }
      const remaining = deadline - Date.now()
      if (signal.aborted || remaining <= 0) throw new Error(`The server in ${app} was not ready after ${httpTimeoutMs / 1000} s.\n${output.slice(-3000)}`)
      await sleep(Math.min(50, remaining))
    }
  }
  catch (error) {
    await stop()
    throw error
  }
  const rss = () => new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`The server in ${app} did not report its RSS.`)), 10_000)
    child.once("message", (message) => {
      clearTimeout(timer)
      done(message.rss)
    })
    child.send("rss", (error) => {
      if (!error) return
      clearTimeout(timer)
      reject(error)
    })
  })
  return { base, output: () => output, rss, stop }
}

async function callConsole(server, key, name, input) {
  const body = JSON.stringify({ t: "q", i: name, m: name, a: [input] })
  const headers = await signConsoleRequest({ body, caller, key, method: "POST", url: `${publicUrl}/_vitehub/rpc` })
  const response = await fetchProbe(`${server.base}/_vitehub/rpc`, { method: "POST", body, headers: { ...headers, "content-type": "application/json" } })
  const text = await response.text()
  let reply
  try {
    reply = JSON.parse(text)
  }
  catch {
    reply = undefined
  }
  const value = reply && typeof reply === "object" && "r" in reply ? reply.r : undefined
  const error = reply && typeof reply === "object" && reply.e && typeof reply.e === "object" ? reply.e : undefined
  return { name, status: response.status, ok: response.ok && value !== undefined, value, code: error?.code, message: typeof error?.message === "string" ? error.message : text.slice(0, 200), fix: typeof error?.fix === "string" ? error.fix : undefined }
}

async function runAgentOnce(server, app) {
  const response = await fetchProbe(`${server.base}/api/agent`)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`GET /api/agent answered ${response.status} in ${app}: ${body.slice(0, 500)}\n${server.output().slice(-3000)}`)
  }
}

function isSessionCookie(cookie, auth) {
  const [pair, ...attributes] = cookie.split(";").map(part => part.trim())
  const nameAndValue = auth === "on" ? /^(?:__Secure-)?better-auth\.session_token=[^\s;]+$/ : /^vitehub_site=[^\s;]+$/
  if (!nameAndValue.test(pair)) return false
  const options = new Map(attributes.map((attribute) => {
    const [name, ...value] = attribute.split("=")
    return [name.toLowerCase(), value.join("=")]
  }))
  const domain = options.get("domain")?.toLowerCase().replace(/^\./, "")
  const hostname = new URL(publicUrl).hostname
  if (options.has("domain") && (!domain?.includes(".") || (hostname !== domain && !hostname.endsWith(`.${domain}`)))) return false
  if (options.get("path") !== "/" || (pair.startsWith("__Secure-") && !options.has("secure"))) return false
  if (options.has("max-age")) return Number(options.get("max-age")) > 0
  return !options.has("expires") || Date.parse(options.get("expires")) > Date.now()
}

async function redeemTicket(server, key, state, auth) {
  const name = "site.link redeem"
  const ticket = new URL(state.ticket)
  if (ticket.origin !== new URL(publicUrl).origin) return { name, ok: false, problem: `ticket points to ${ticket.origin}` }
  const response = await fetchProbe(`${server.base}${ticket.pathname}${ticket.search}`, { redirect: "manual" })
  await response.arrayBuffer()
  const location = response.headers.get("location")
  const cookies = response.headers.getSetCookie()
  const sessions = await callConsole(server, key, "site.sessions", {})
  const list = Array.isArray(sessions.value?.sessions) ? sessions.value.sessions : []
  state.session = list[0]?.id
  const problem = response.status !== 303
    ? `answered ${response.status}, not 303`
    : !location || new URL(location, publicUrl).origin !== new URL(publicUrl).origin
      ? `redirects to ${location ?? "nothing"}`
      : !cookies.some(cookie => isSessionCookie(cookie, auth))
          ? "sets no session cookie for the fixture"
          : !sessions.ok || list.length <= (state.sessionsBefore ?? 0)
              ? "site.sessions lists no new session"
              : undefined
  return { name, status: response.status, ok: !problem, problem }
}

async function runConsoleOperations(server, key, auth) {
  const calls = []
  const state = {}
  for (const [name, input, accepted = [], after] of operationProbes) {
    const call = await callConsole(server, key, name, typeof input === "function" ? input(state) : input)
    const problem = call.ok && after ? after(call.value, state) : undefined
    calls.push({ name, status: call.status, ok: call.ok && !problem, accepted, problem, code: call.code, message: call.ok ? undefined : call.message, fix: call.fix })
    if (name === "site.link" && !problem && call.ok) calls.push(await redeemTicket(server, key, state, auth))
  }
  return { calls, exposed: state.exposed }
}

function isSqlite(file) {
  const handle = openSync(file, "r")
  const header = Buffer.alloc(16)
  const read = readSync(handle, header, 0, 16, 0)
  closeSync(handle)
  return read === 16 && header.toString("latin1") === "SQLite format 3\0"
}

async function listTables(app) {
  const { DatabaseSync } = await import("node:sqlite")
  const data = join(app, ".vitehub/data")
  const entries = []
  for (const file of walk(data).filter(isSqlite)) {
    const db = new DatabaseSync(file, { readOnly: true })
    const rows = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'").all()
    db.close()
    for (const row of rows) entries.push(`${row.type} ${relative(data, file)}:${row.name}`)
  }
  return entries.sort()
}

async function pageForVisitor(server) {
  const response = await fetchProbe(`${server.base}/`, { headers: { accept: "text/html" }, redirect: "manual" })
  const body = Buffer.from(await response.arrayBuffer())
  const text = body.toString("utf8")
  return { status: response.status, body, comparable: response.status === 200 && text.includes("<title>Console weight</title>") && text.includes("id=\"app\"") }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function envNamesIn(text) {
  return [...String(text ?? "").matchAll(/\bVITEHUB_[A-Z0-9_]+\b/g)].map(match => match[0]).filter(name => !name.startsWith("VITEHUB_CONSOLE_KEY_"))
}

function isOperationMissing(call) {
  return call.status === 404 && call.code === "CONSOLE_NOT_FOUND" && call.message === operationMissing
}

function operationProblems({ calls, exposed }, auth) {
  exposed ??= []
  const retained = retainedOperations(auth)
  const probed = new Set(calls.map(call => call.name))
  const unprobed = exposed.filter(name => !probed.has(name)).map(name => ({ name, problem: "exposed, no probe" }))
  const unlisted = retained.filter(name => !exposed.includes(name)).map(name => ({ name, problem: "retained, not listed" }))
  const failed = calls.flatMap((call) => {
    if (call.ok) return []
    if (call.problem) return [{ name: call.name, problem: call.problem }]
    if (isOperationMissing(call)) return retained.includes(call.name) || exposed.includes(call.name) ? [{ name: call.name, problem: "listed, missing" }] : []
    if (retained.includes(call.name)) return [{ name: call.name, problem: `${call.status} ${call.code}` }]
    return call.accepted.includes(call.code) ? [] : [{ name: call.name, problem: `${call.status} ${call.code}` }]
  })
  return [...unprobed, ...unlisted, ...failed]
}

async function withServer(app, env, use) {
  const server = await startServer(app, env)
  try {
    return await use(server)
  }
  finally {
    await server.stop()
  }
}

function residentAtReady(app, env) {
  return withServer(app, env, async (server) => {
    await sleep(settleMs)
    return await server.rss()
  })
}

async function runtimeMeasures(apps, auth) {
  const pair = await createConsoleKeyPair()
  const key = { name: keyName, privateKey: pair.privateKey }
  const secret = "console-weight-secret-0123456789abcdef0123456789"
  const base = { [`VITEHUB_CONSOLE_KEY_${keyName}`]: pair.publicKey, ...auth === "on" ? { BETTER_AUTH_SECRET: secret } : {} }

  const probeRun = await withServer(apps.on, base, async (server) => {
    await runAgentOnce(server, apps.on)
    return await runConsoleOperations(server, key, auth)
  })
  const missingEnv = [...new Set(operationProblems(probeRun, auth).flatMap(({ name }) => probeRun.calls.filter(call => call.name === name)).flatMap(call => envNamesIn(`${call.message} ${call.fix ?? ""}`)))].filter(name => !(name in base)).sort()
  const extra = Object.fromEntries(missingEnv.map(name => [name, name.endsWith("SECRET") ? secret : "console-weight"]))
  const env = { ...base, ...extra }

  const result = { missingEnv, off: {}, on: {}, memory: { offA: [], on: [], offB: [] } }
  for (const mode of ["off", "on"]) {
    const { page, operations } = await withServer(apps[mode], env, async (server) => {
      const page = await pageForVisitor(server)
      await runAgentOnce(server, apps[mode])
      return { page, operations: await runConsoleOperations(server, key, auth) }
    })
    result[mode] = { page, operations, tables: await listTables(apps[mode]) }
  }
  for (let round = 0; round < memoryRounds; round++) {
    result.memory.offA.push(await residentAtReady(apps.off, env))
    result.memory.on.push(await residentAtReady(apps.on, env))
    result.memory.offB.push(await residentAtReady(apps.off, env))
  }
  return result
}

function formatBytes(bytes, unit = kB, label = "kB") {
  return `${(bytes / unit).toFixed(1)} ${label}`
}

function signed(value, format) {
  return `${value > 0 ? "+" : value < 0 ? "-" : "+"}${format(Math.abs(value))}`
}

function list(values, limit = 4) {
  if (!values.length) return "none"
  return values.length > limit ? `${values.slice(0, limit).join(", ")}, +${values.length - limit} more` : values.join(", ")
}

function tableSummary(entries) {
  const tables = entries.filter(entry => entry.startsWith("table ")).length
  return `${tables} tables, ${entries.length - tables} triggers`
}

const rows = []

function addRow(row) {
  rows.push(row)
}

async function main() {
  if (!existsSync(join(repo, "packages/vite-hub/dist/bin.js")) || !existsSync(join(repo, "packages/internal/dist/console-signature.js"))) {
    fail("Build the packages first: corepack pnpm exec vp run build")
  }
  mkdirSync(options.work, { recursive: true })
  const runDirectory = mkdtempSync(join(options.work, "vitehub-console-weight-"))
  log(`Building the fixture app in ${runDirectory}`)

  const builds = {}
  for (const host of hosts) {
    for (const auth of authModes) {
      const apps = {}
      for (const consoleMode of ["off", "on"]) apps[consoleMode] = await buildApp(runDirectory, host, auth, consoleMode)
      builds[`${host}-${auth}`] = { host, auth, apps, off: staticMeasures(apps.off, host), on: staticMeasures(apps.on, host) }
    }
  }

  const runtime = {}
  for (const auth of authModes) {
    log(`  ${variantName("node", auth)}: starting the servers`)
    runtime[auth] = await runtimeMeasures(builds[`node-${auth}`].apps, auth)
  }

  for (const build of Object.values(builds)) {
    const { host, auth, off, on } = build
    const growth = startupGrowth(off.startup, on.startup)
    const describe = startup => `${Object.keys(startup.sources).length} source modules, ${formatBytes(startup.sourceBytes)}`
    addRow({
      id: "startup",
      measure: "Startup code",
      variant: variantName(host, auth),
      off: describe(off.startup),
      on: describe(on.startup),
      change: `+${growth.added.length} source modules, ${signed(growth.bytes, formatBytes)} traced, ${signed(growth.unmappedBytes, formatBytes)} unmapped`,
      target: "+0 source modules, at most +1 kB",
      result: growth.result,
      details: {
        added: growth.added,
        grown: growth.grown,
        chunks: { off: off.startup.modules.length, on: on.startup.modules.length },
        unmapped: { off: off.startup.unmapped, on: on.startup.unmapped },
      },
    })
  }

  for (const auth of authModes) {
    const { off, on } = runtime[auth]
    const comparable = off.page.comparable && on.page.comparable
    const same = comparable && off.page.body.equals(on.page.body)
    const describe = page => `${page.status}, ${page.body.length} B${page.comparable ? "" : ", not the fixture page"}`
    addRow({
      id: "html",
      measure: "HTML for visitors (Node)",
      variant: variantName("node", auth),
      off: describe(off.page),
      on: describe(on.page),
      change: !comparable ? "not comparable" : same ? "identical" : `${signed(on.page.body.length - off.page.body.length, value => `${value} B`)}, differs`,
      target: "200, byte-identical",
      result: same ? "PASS" : "FAIL",
      details: same ? {} : { off: off.page.body.toString("utf8"), on: on.page.body.toString("utf8") },
    })
  }

  for (const build of Object.values(builds)) {
    const { host, auth, off, on } = build
    addRow({
      id: "public",
      measure: "Public /_vitehub files",
      variant: variantName(host, auth),
      off: `${off.publicFiles.length} files`,
      on: `${on.publicFiles.length} files`,
      change: `${signed(on.publicFiles.length - off.publicFiles.length, String)} files`,
      target: "0 files",
      result: on.publicFiles.length === 0 ? "PASS" : "FAIL",
      details: { files: on.publicFiles.filter(file => !off.publicFiles.includes(file)) },
    })
  }

  for (const auth of authModes) {
    const { off, on } = builds[`cloudflare-${auth}`]
    const change = on.server.gzip - off.server.gzip
    const configured = configuredPrimitives(auth)
    const strays = chunkGrowth(off.attribution.chunks, on.attribution.chunks).filter(entry => primitives.includes(entry.owner) && !configured.includes(entry.owner))
    const unconfigured = [...new Set(strays.map(entry => entry.owner))].sort()
    addRow({
      id: "server",
      measure: "Server output gzip",
      variant: variantName("cloudflare", auth),
      off: `${formatBytes(off.server.gzip)} gzip`,
      on: `${formatBytes(on.server.gzip)} gzip`,
      change: `${signed(change, formatBytes)} gzip${unconfigured.length ? `, pulls ${list(unconfigured, 4)}` : ""}`,
      target: "at most +137 kB gzip, no unconfigured primitive",
      result: change <= 137 * kB && !unconfigured.length ? "PASS" : "FAIL",
      details: { off: off.server, on: on.server, rawChange: on.server.raw - off.server.raw, configured, unconfigured, chunksWithUnconfiguredOwners: strays.sort((a, b) => b.bytes - a.bytes) },
    })
  }

  for (const build of Object.values(builds)) {
    const { host, auth, off, on } = build
    const glue = on.attribution.glue.gzip - off.attribution.glue.gzip
    const unattributed = on.attribution.unattributed - off.attribution.unattributed
    const provenance = unattributed <= ownerNoise
    addRow({
      id: "glue",
      measure: "Console glue gzip",
      variant: variantName(host, auth),
      off: `${formatBytes(off.attribution.glue.gzip)} gzip`,
      on: `${formatBytes(on.attribution.glue.gzip)} gzip`,
      change: `${signed(glue, formatBytes)} gzip, ${signed(unattributed, value => `${value} B`)} unattributed`,
      target: "at most 20 kB gzip",
      result: glue > 20 * kB ? "FAIL" : provenance ? "PASS" : "INCONCLUSIVE",
      details: {
        sources: consoleSources,
        raw: on.attribution.glue.raw,
        unattributed: { off: off.attribution.unattributed, on: on.attribution.unattributed, files: on.attribution.unattributedFiles },
        linkage: { off: off.attribution.linkage, on: on.attribution.linkage },
        total: on.attribution.total,
      },
    })
  }

  for (const auth of authModes) {
    const { off, on } = runtime[auth]
    const added = on.tables.filter(entry => !off.tables.includes(entry))
    const removed = off.tables.filter(entry => !on.tables.includes(entry))
    const problems = operationProblems(on.operations, auth)
    const tableChange = added.length || removed.length ? list([...added.map(entry => `+${entry.split(":")[1]}`), ...removed.map(entry => `-${entry.split(":")[1]}`)], 3) : "same"
    addRow({
      id: "tables",
      measure: "Tables after Console operations (Node)",
      variant: variantName("node", auth),
      off: tableSummary(off.tables),
      on: tableSummary(on.tables),
      change: `${on.operations.calls.length} probes, ${problems.length ? `${problems.length} failed: ${list(problems.map(problem => `${problem.name} ${problem.problem}`), 2)}` : "all as expected"}; ${tableChange}`,
      target: "same as Console off, every listed operation probed",
      result: !problems.length && !added.length && !removed.length ? "PASS" : "FAIL",
      details: { added, removed, exposed: on.operations.exposed, calls: on.operations.calls, problems },
    })
  }

  for (const host of hosts) {
    const { off, on } = builds[`${host}-on`]
    const changes = schemaDiff(off.authSchema, on.authSchema)
    const roleIn = schema => schema.userColumns.filter(column => consoleOnlyAuthColumns.includes(column))
    const describe = schema => schema.hasUser ? `${schema.statements.length} statements${roleIn(schema).length ? `, has ${roleIn(schema).join(", ")}` : ""}` : "no user table"
    const hasUser = off.authSchema.hasUser && on.authSchema.hasUser
    addRow({
      id: "auth-schema",
      measure: "Auth schema",
      variant: variantName(host, "on"),
      off: describe(off.authSchema),
      on: describe(on.authSchema),
      change: !hasUser ? "no user table to compare" : changes.length ? list(changes, 2) : roleIn(on.authSchema).length ? `identical, ${roleIn(on.authSchema).join(", ")} in both` : "identical",
      target: `identical, no ${consoleOnlyAuthColumns.join(", ")}`,
      result: hasUser && !changes.length && !roleIn(on.authSchema).length ? "PASS" : "FAIL",
      details: { changes, offColumns: roleIn(off.authSchema), onColumns: roleIn(on.authSchema) },
    })
  }

  for (const build of Object.values(builds)) {
    const { host, auth, off, on } = build
    const declared = on.declaredEnv.filter(entry => !off.declaredEnv.includes(entry))
    const keyEntry = `VITEHUB_CONSOLE_KEY_<NAME>`
    const keyDeclared = declared.includes(keyEntry)
    const manifestOnly = host !== "node"
    const runtimeEnv = manifestOnly ? [] : runtime[auth].missingEnv
    const extra = [...new Set([...declared.filter(entry => entry !== keyEntry), ...runtimeEnv])].sort()
    addRow({
      id: "env",
      measure: "Required env",
      variant: variantName(host, auth),
      off: `${off.declaredEnv.length} required`,
      on: `${on.declaredEnv.length} required`,
      change: [[keyDeclared ? "" : "key not declared", extra.length ? `+${list(extra, 3)}` : ""].filter(Boolean).join(", ") || "key only", manifestOnly ? "manifest only" : ""].filter(Boolean).join(", "),
      target: `only ${keyEntry}`,
      result: keyDeclared && !extra.length ? "PASS" : "FAIL",
      details: { declaredAdded: declared, judgedOn: manifestOnly ? "manifest" : "manifest and Node runtime", missingAtRuntimeOnNode: runtime[auth].missingEnv, readByConsoleCode: on.attribution.glue.envLiterals },
    })
  }

  for (const auth of authModes) {
    const memory = runtime[auth].memory
    const verdict = memoryVerdict(memory)
    const mb = value => formatBytes(value, MB, "MB")
    addRow({
      id: "memory",
      measure: "Memory at ready (Node)",
      variant: variantName("node", auth),
      off: `${mb(median(memory.offA))} RSS`,
      on: `${mb(median(memory.on))} RSS`,
      change: `${signed(verdict.change, mb)} [${signed(verdict.lower, mb)}, ${signed(verdict.upper, mb)}], noise ${mb(verdict.noise)}`,
      target: `within ±${mb(memoryBudget)}`,
      result: verdict.result,
      details: { ...memory, ...verdict, rounds: memoryRounds, settleMs },
    })
  }

  const failed = rows.filter(row => row.result !== "PASS")
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()
  const report = { commit, generatedAt: new Date().toISOString(), work: runDirectory, consoleSources, pass: !failed.length, rows: rows.map(row => ({ ...row, pass: row.result === "PASS" })) }

  if (options.json === "-") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    printTable(rows)
    log(`\n${rows.length - failed.length} of ${rows.length} rows pass at ${commit}.`)
    log(`Console glue: output bytes that the server sourcemaps trace to ${consoleSources.join(", ")}.`)
    log("Startup code: the source modules and bytes that server sourcemaps trace in the output chunks that index.mjs imports statically. An added module or more than 1 kB of traced growth fails. If traced and unmapped growth together exceed 1 kB without a traced failure, the result is inconclusive. A module that only moves to another chunk does not count.")
    log("Server owners: the source package of each output byte, per chunk. The row fails when a new or changed chunk adds any bytes of a primitive the fixture does not configure. A Console-on chunk whose code (without import and export lines) is the same as a Console-off chunk does not count; each Console-off chunk matches one Console-on chunk at most.")
    log(`Node rows run the Node build. Memory: ${memoryRounds} rounds of off A, on, off B, RSS ${settleMs / 1000} s after the first 200 from /api/touch. The change is the median of on minus the mean of the two off readings in each round. The range uses the medians of on minus the higher and lower off readings. It passes if the range fits within ±${formatBytes(memoryBudget, MB, "MB")}, fails if the range is entirely outside the budget on one side, and is otherwise inconclusive. The result is also inconclusive when twice the mean off/off gap exceeds ${formatBytes(memoryNoiseLimit, MB, "MB")}. Tables: after one Agent run, then ${operationProbes.length} operation probes and the Site link redeem. Cloudflare env rows read the deployment manifest only.`)
    if (options.json) {
      writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`)
      log(`Wrote ${options.json}`)
    }
  }
  if (options.keep) log(`Kept ${runDirectory}`)
  else rmSync(runDirectory, { recursive: true, force: true })
  process.exitCode = failed.length ? 1 : 0
}

function printTable(entries) {
  const header = ["Measure", "Variant", "Console off", "Console on", "Change", "Target", "Result"]
  const lines = entries.map(row => [row.measure, row.variant, row.off, row.on, row.change, row.target, row.result])
  const widths = header.map((title, column) => Math.max(title.length, ...lines.map(line => line[column].length)))
  const format = line => line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()
  log("")
  log(format(header))
  log(format(widths.map(width => "-".repeat(width))))
  for (const line of lines) log(format(line))
}

await main()
