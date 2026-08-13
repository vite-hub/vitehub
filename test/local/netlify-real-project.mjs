#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"

const repoRoot = resolve(import.meta.dirname, "..", "..")
const baseDir = "/tmp/netlify"
const appName = "vitehub-agent-netlify"
const appDir = join(baseDir, appName)
const log = message => console.log(`[e2e:netlify] ${message}`)

function assert(condition, message) {
  if (!condition) throw new Error(`[e2e:netlify] ${message}`)
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    input: options.input,
    stdio: options.stdio ?? "inherit",
  })
  if (result.status !== 0) {
    throw new Error(`[e2e:netlify] ${command} ${args.join(" ")} failed with exit ${result.status}`)
  }
  return result
}

function packageTarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`
}

async function readPackageJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

async function createLocalPackageSpecs(packDir) {
  await mkdir(packDir, { recursive: true })
  const packagesDir = join(repoRoot, "packages")
  const specs = {}
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageDir = join(packagesDir, entry.name)
    const pkg = await readPackageJson(join(packageDir, "package.json"))
    if (typeof pkg.name !== "string" || (pkg.name !== "vite-hub" && !pkg.name.startsWith("@vite-hub/"))) continue
    run("pnpm", ["--filter", pkg.name, "pack", "--pack-destination", packDir], { cwd: repoRoot })
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
    "  '@mongodb-js/zstd': true",
    "  '@swc/core': true",
    "  cbor-extract: true",
    "  esbuild: true",
    "  msgpackr-extract: false",
    "  node-liblzma: true",
    "catalog:",
    "  vite: npm:@voidzero-dev/vite-plus-core@0.1.24",
    "  vitest: npm:@voidzero-dev/vite-plus-test@0.1.24",
    "  vite-plus: 0.1.24",
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
  await mkdir(join(appDir, "src", "lib"), { recursive: true })
  await mkdir(join(appDir, "server", "agents"), { recursive: true })
  await writeFile(join(appDir, "src", "lib", "reply.ts"), "export const replyMarker = \"netlify-alias-ok\"\n", "utf8")
  await writeFile(join(appDir, "server", "agents", "support.ts"), [
    "import { defineAgent } from \"@vite-hub/agent\"",
    "import { webChat } from \"@vite-hub/agent/channels\"",
    "import { replyMarker } from \"@/lib/reply\"",
    "",
    "export default defineAgent({",
    "  channels: { portal: webChat },",
    "  driver: {",
    "    run({ messages }) {",
    "      const latest = messages.at(-1)",
    "      const text = latest?.parts.find(part => part.type === \"text\")?.text || \"\"",
    "      return `${replyMarker}:message:${text}`",
    "    },",
    "  },",
    "})",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(appDir, "vite.config.ts"), [
    "import { fileURLToPath, URL } from \"node:url\"",
    "",
    "import { vitehub } from \"vite-hub\"",
    "import { defineConfig } from \"vite-plus\"",
    "",
    "export default defineConfig({",
    "  build: { outDir: \"dist/client\" },",
    "  fmt: {},",
    "  lint: { options: { typeAware: true, typeCheck: true } },",
    "  plugins: [vitehub({",
    "    preset: \"netlify\",",
    "    agent: {",
    "      providers: { state: { provider: \"memory\" } },",
    "    },",
    "    blob: {},",
    "    database: false,",
    "    env: false,",
    "    kv: false,",
    "    sandbox: false,",
    "    schedule: false,",
    "    workflow: false,",
    "    workspace: false,",
    "  })],",
    "  resolve: {",
    "    alias: { \"@\": fileURLToPath(new URL(\"./src\", import.meta.url)) },",
    "  },",
    "})",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(appDir, "tsconfig.json"), [
    "{",
    "  \"compilerOptions\": {",
    "    \"target\": \"es2023\",",
    "    \"module\": \"esnext\",",
    "    \"lib\": [\"ES2023\", \"DOM\"],",
    "    \"types\": [\"vite/client\"],",
    "    \"skipLibCheck\": true,",
    "    \"moduleResolution\": \"bundler\",",
    "    \"allowImportingTsExtensions\": true,",
    "    \"verbatimModuleSyntax\": true,",
    "    \"moduleDetection\": \"force\",",
    "    \"noEmit\": true,",
    "    \"noUnusedLocals\": true,",
    "    \"noUnusedParameters\": true,",
    "    \"erasableSyntaxOnly\": true,",
    "    \"noFallthroughCasesInSwitch\": true,",
    "    \"paths\": {",
    "      \"@/*\": [\"./src/*\"]",
    "    }",
    "  },",
    "  \"include\": [\"src\", \"server\"]",
    "}",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(appDir, "netlify.toml"), [
    "[build]",
    "command = \"pnpm build\"",
    "publish = \"dist/client\"",
    "",
  ].join("\n"), "utf8")
}

async function createProject({ packageSource, preview }) {
  await mkdir(baseDir, { recursive: true })
  await rm(appDir, { force: true, recursive: true })
  run("vp", ["create", "vite:application", "--directory", appName, "--no-interactive", "--no-hooks", "--package-manager", "pnpm"], { cwd: baseDir })

  const overrides = packageSource === "local"
    ? await createLocalPackageSpecs(join(baseDir, "vitehub-packs"))
    : { "vite-hub": previewSpec("vite-hub", preview) }
  await writeFixtureFiles(overrides)

  const packageSpecs = packageSource === "local"
    ? [overrides["@vite-hub/agent"], overrides["vite-hub"]]
    : [previewSpec("@vite-hub/agent", preview), previewSpec("vite-hub", preview)]

  run("pnpm", [
    "add",
    ...(packageSource === "preview" ? ["--config.blockExoticSubdeps=false"] : []),
    ...packageSpecs,
  ], { cwd: appDir })
}

async function assertNetlifyFunctionOutput() {
  const functionFile = join(appDir, ".netlify", "v1", "functions", "vitehub-agent.mjs")
  assert(existsSync(functionFile), "missing .netlify/v1/functions/vitehub-agent.mjs")
  const source = await readFile(functionFile, "utf8")
  for (const expected of [
    "export const config = {",
    "\"name\": \"vitehub-agent\"",
    "\"nodeBundler\": \"esbuild\"",
    "\"/api/_vitehub/agents/:agent/chat\"",
    "VITEHUB_HOSTING",
    "globalThis.__filename",
    "globalThis.__dirname",
    "netlify-alias-ok",
  ]) {
    assert(source.includes(expected), `Netlify function output missing ${expected}`)
  }
  assert(!source.includes("from \"@/"), "Netlify function output left the Vite alias unresolved")
  assert(!source.includes("function config("), "Netlify function output used dynamic function config")
}

async function postChat(port) {
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
  if (!response.ok) {
    throw new Error(`chat route returned ${response.status}: ${text}`)
  }
  assert(text.includes("netlify-alias-ok"), `chat response missed alias marker: ${text}`)
  assert(text.includes("message:ping"), `chat response missed echoed message: ${text}`)
  return text
}

async function waitForChat(port, timeoutMs = 90_000) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await postChat(port)
    }
    catch (error) {
      lastError = error
      await sleep(1_000)
    }
  }
  throw new Error(`[e2e:netlify] chat route never became healthy: ${lastError}`)
}

function spawnLogged(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`)
  const child = spawn(command, args, {
    cwd: options.cwd ?? appDir,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", chunk => process.stdout.write(`[netlify-dev] ${chunk}`))
  child.stderr.on("data", chunk => process.stderr.write(`[netlify-dev] ${chunk}`))
  return child
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await sleep(750)
  if (child.exitCode === null) child.kill("SIGKILL")
}

async function runNetlifyDevProof() {
  await rm(join(appDir, ".netlify"), { force: true, recursive: true })
  await rm(join(appDir, "dist"), { force: true, recursive: true })
  const port = 8888
  const targetPort = 5173
  const dev = spawnLogged("netlify", [
    "dev",
    "--offline",
    "--no-open",
    "--port",
    String(port),
    "--target-port",
    String(targetPort),
    "--command",
    "pnpm dev -- --host 127.0.0.1",
  ])
  try {
    const text = await waitForChat(port)
    log(`netlify dev chat route ✓ ${JSON.stringify(text.slice(0, 120))}`)
    await assertNetlifyFunctionOutput()
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
const preview = values.preview || process.env.VITEHUB_NETLIFY_PREVIEW
if (packageSource === "preview") {
  assert(preview, "--preview <pr-or-sha> or VITEHUB_NETLIFY_PREVIEW is required for --package-source preview")
}

try {
  await createProject({ packageSource, preview })
  run("netlify", ["--version"], { cwd: appDir })
  run("netlify", ["build", "--offline"], { cwd: appDir })
  await assertNetlifyFunctionOutput()
  run("netlify", ["functions:build", "--src", ".netlify/v1/functions", "--functions", ".netlify/functions-build"], { cwd: appDir })
  await runNetlifyDevProof()
  log(`real project proof passed at ${appDir}`)
}
finally {
  if (!values.keep) {
    await rm(appDir, { force: true, recursive: true })
  }
}
