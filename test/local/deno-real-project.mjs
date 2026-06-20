#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"

const repoRoot = resolve(import.meta.dirname, "..", "..")
const baseDir = "/tmp/deno"
const appName = "vitehub-agent-deno"
const appDir = join(baseDir, appName)
const deno = process.env.DENO || "/opt/homebrew/bin/deno"
const port = Number(process.env.VITEHUB_DENO_E2E_PORT || 8787)
const logDir = join(baseDir, "logs")
const log = message => console.log(`[e2e:deno] ${message}`)

function assert(condition, message) {
  if (!condition) throw new Error(`[e2e:deno] ${message}`)
}

function packageTarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`
}

async function readPackageJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`)
  const logFile = options.logName ? join(logDir, options.logName) : undefined
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? (logFile ? "pipe" : "inherit"),
  })
  if (logFile) {
    const output = `${result.stdout || ""}${result.stderr || ""}`
    if (output) {
      process.stdout.write(output)
      if (options.appendLog) appendFileSync(logFile, output)
      else writeFileSync(logFile, output)
    }
  }
  if (result.status !== 0) {
    throw new Error(`[e2e:deno] ${command} ${args.join(" ")} failed with exit ${result.status}`)
  }
  return result
}

async function createLocalPackageSpecs(packDir) {
  await mkdir(packDir, { recursive: true })
  const specs = {}
  for (const entry of await readdir(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageDir = join(repoRoot, "packages", entry.name)
    const pkg = await readPackageJson(join(packageDir, "package.json"))
    if (typeof pkg.name !== "string" || !pkg.name.startsWith("@vite-hub/")) continue
    run("pnpm", ["--filter", pkg.name, "pack", "--pack-destination", packDir], { appendLog: true, cwd: repoRoot, logName: "pack.log" })
    specs[pkg.name] = `file:${join(packDir, packageTarballName(pkg.name, pkg.version))}`
  }
  return specs
}

function previewSpec(packageName, preview) {
  return `https://pkg.pr.new/vite-hub/vitehub/${packageName}@${preview}`
}

function renderWorkspaceYaml(overrides) {
  const overrideLines = Object.entries(overrides).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)
  return [
    "allowBuilds:",
    "  esbuild: true",
    "catalog:",
    "  vite: npm:@voidzero-dev/vite-plus-core@latest",
    "  vitest: npm:@voidzero-dev/vite-plus-test@latest",
    "  vite-plus: latest",
    "overrides:",
    "  vite: \"catalog:\"",
    "  vitest: \"catalog:\"",
    ...overrideLines,
    "peerDependencyRules:",
    "  allowAny:",
    "    - vite",
    "    - vitest",
    "  allowedVersions:",
    "    vite: \"*\"",
    "    vitest: \"*\"",
    "",
  ].join("\n")
}

async function writeFixtureFiles(overrides) {
  await writeFile(join(appDir, "pnpm-workspace.yaml"), renderWorkspaceYaml(overrides), "utf8")
  await mkdir(join(appDir, "server", "agents"), { recursive: true })
  await writeFile(join(appDir, "server", "agents", "support.ts"), [
    "import { defineAgent } from \"@vite-hub/agent\"",
    "import { chat } from \"@vite-hub/agent/capabilities\"",
    "",
    "export default defineAgent({",
    "  capabilities: [chat()],",
    "  run({ messages }) {",
    "    const latest = messages.at(-1)",
    "    const text = latest?.parts.find(part => part.type === \"text\")?.text || \"\"",
    "    return `deno-real-project:message:${text}`",
    "  },",
    "})",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(appDir, "vite.config.ts"), [
    "import { hubAgent } from \"@vite-hub/agent/vite\"",
    "import { defineConfig } from \"vite-plus\"",
    "",
    "export default defineConfig({",
    "  agent: {",
    "    runtime: \"deno\",",
    "    providers: { state: { provider: \"memory\" } },",
    "    routes: { chat: true, webhooks: true },",
    "  },",
    "  build: { outDir: \"dist/client\" },",
    "  fmt: {},",
    "  lint: { options: { typeAware: true, typeCheck: true } },",
    "  plugins: [hubAgent()],",
    "})",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(appDir, "tsconfig.json"), [
    "{",
    "  \"compilerOptions\": {",
    "    \"target\": \"es2023\",",
    "    \"module\": \"esnext\",",
    "    \"lib\": [\"ES2023\", \"DOM\", \"DOM.Iterable\"],",
    "    \"types\": [\"vite/client\"],",
    "    \"skipLibCheck\": true,",
    "    \"moduleResolution\": \"bundler\",",
    "    \"allowImportingTsExtensions\": true,",
    "    \"verbatimModuleSyntax\": true,",
    "    \"moduleDetection\": \"force\",",
    "    \"noEmit\": true,",
    "    \"erasableSyntaxOnly\": true,",
    "    \"paths\": {}",
    "  },",
    "  \"include\": [\"server\", \"vite.config.ts\"]",
    "}",
    "",
  ].join("\n"), "utf8")
}

async function createProject({ packageSource, preview }) {
  await mkdir(logDir, { recursive: true })
  await rm(logDir, { force: true, recursive: true })
  await mkdir(logDir, { recursive: true })
  await rm(appDir, { force: true, recursive: true })
  run("vp", ["create", "vite:application", "--directory", appName, "--no-interactive", "--no-hooks", "--package-manager", "pnpm"], { cwd: baseDir, logName: "create.log" })

  const overrides = packageSource === "local"
    ? await createLocalPackageSpecs(join(baseDir, "vitehub-packs"))
    : {}
  await writeFixtureFiles(overrides)

  const proofPackages = ["@vite-hub/agent"]
  const packageSpecs = packageSource === "local"
    ? proofPackages.map(name => overrides[name])
    : proofPackages.map(name => previewSpec(name, preview))

  run("pnpm", [
    "add",
    ...(packageSource === "preview" ? ["--config.blockExoticSubdeps=false"] : []),
    ...packageSpecs,
  ], { cwd: appDir, logName: "install.log" })
}

async function assertGeneratedOutput() {
  const denoServer = join(appDir, ".vitehub", "agent", "deno-server.ts")
  assert(existsSync(denoServer), "missing .vitehub/agent/deno-server.ts")
  const source = await readFile(denoServer, "utf8")
  for (const expected of [
    "import { withAgentDefaults } from '@vite-hub/agent'",
    "import { defineAgentChatFetchHandler, defineAgentChatWebhookFetchHandler } from '@vite-hub/agent/server/routes'",
    "await import('../schedule/deno-cron.mjs').catch",
    "const chatRoutePattern = new RegExp",
    "/api/_vitehub/agents/(?<agent>[^/]+)/chat",
  ]) {
    assert(source.includes(expected), `Deno server output missing ${expected}`)
  }
  for (const forbidden of [
    "from \"@/",
    "from '@/",
    "import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/runtime'",
    repoRoot,
  ]) {
    assert(!source.includes(forbidden), `Deno server output contains forbidden ${forbidden}`)
  }
  return denoServer
}

async function postChat() {
  const response = await fetch(`http://127.0.0.1:${port}/api/_vitehub/agents/support/chat`, {
    body: JSON.stringify({
      id: "real-project-thread",
      messages: [{
        id: "m1",
        parts: [{ text: "ping", type: "text" }],
        role: "user",
      }],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  const text = await response.text()
  await writeFile(join(logDir, "chat-route.log"), text, "utf8")
  if (!response.ok) throw new Error(`chat route returned ${response.status}: ${text}`)
  assert(text.includes("deno-real-project"), `chat response missed proof marker: ${text}`)
  assert(text.includes("message:ping"), `chat response missed echoed message: ${text}`)
  return text
}

async function waitForChat(child, timeoutMs = 90_000) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`deno process exited with ${child.exitCode}; see ${join(logDir, "deno-run.log")}`)
    }
    try {
      return await postChat()
    }
    catch (error) {
      lastError = error
      await sleep(1_000)
    }
  }
  throw new Error(`[e2e:deno] chat route never became healthy: ${lastError}`)
}

function spawnLogged(command, args) {
  log(`${command} ${args.join(" ")}`)
  const child = spawn(command, args, {
    cwd: appDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const logFile = join(logDir, "deno-run.log")
  child.stdout.on("data", chunk => {
    process.stdout.write(`[deno-serve] ${chunk}`)
    appendFile(logFile, chunk).catch(() => undefined)
  })
  child.stderr.on("data", chunk => {
    process.stderr.write(`[deno-serve] ${chunk}`)
    appendFile(logFile, chunk).catch(() => undefined)
  })
  return child
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await sleep(750)
  if (child.exitCode === null) child.kill("SIGKILL")
}

async function runDenoServeProof(denoServer) {
  await rm(join(logDir, "deno-run.log"), { force: true })
  await rm(join(logDir, "chat-route.log"), { force: true })
  const dev = spawnLogged(deno, ["run", `--allow-net=127.0.0.1:${port}`, denoServer, "--host", "127.0.0.1", "--port", String(port)])
  try {
    const text = await waitForChat(dev)
    log(`deno run chat route ✓ ${JSON.stringify(text.slice(0, 120))}`)
  }
  finally {
    await stopProcess(dev)
  }
}

const args = process.argv.slice(2)
if (args[0] === "--") args.shift()

const { values } = parseArgs({
  args,
  options: {
    "package-source": { type: "string" },
    keep: { type: "boolean" },
    preview: { type: "string" },
  },
  strict: true,
})

const packageSource = values["package-source"] || "local"
assert(packageSource === "local" || packageSource === "preview", "--package-source must be local or preview")
const preview = values.preview || process.env.VITEHUB_DENO_PREVIEW
if (packageSource === "preview") {
  assert(preview, "--preview <pr-or-sha> or VITEHUB_DENO_PREVIEW is required for --package-source preview")
}

try {
  await createProject({ packageSource, preview })
  run("pnpm", ["build"], { cwd: appDir, logName: "build.log" })
  const denoServer = await assertGeneratedOutput()
  await runDenoServeProof(denoServer)
  log(`real project proof passed at ${appDir}`)
}
finally {
  if (!values.keep) {
    await rm(appDir, { force: true, recursive: true })
  }
}
