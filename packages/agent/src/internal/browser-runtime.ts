import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"

import type { AgentInvocationContextStore } from "../types.ts"
import { redactCredentialText } from "./credential-redaction.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

const agentBrowserVersion = "0.35.2"
const puppeteerBrowsersVersion = "2.10.10"
const chromiumBundleVersion = "149.0.0"
const chromeForTestingVersion = "149.0.7827.155"
const browserRuntimeEnvironmentContextKey = "vitehub.browser.runtime.environment"
const preparations = new Map<string, Promise<PreparedBrowserRuntime>>()

export interface PreparedBrowserRuntime {
  command: string
  environment: Readonly<Record<string, string>>
  skillContent: string
}

export interface BrowserRuntimePreparationOptions {
  cacheRoot?: string
  npmCommand?: string
  platform?: NodeJS.Platform
}

function defaultCacheRoot(): string {
  const configured = process.env.VITEHUB_CACHE_DIR?.trim()
  const xdg = process.env.XDG_CACHE_HOME?.trim()
  return join(configured || join(xdg || join(homedir(), ".cache"), "vitehub"), "browser", `agent-browser-${agentBrowserVersion}-chromium-${chromiumBundleVersion}-chrome-${chromeForTestingVersion}`)
}

function run(command: string, args: readonly string[], options: { cwd?: string, env: NodeJS.ProcessEnv, timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => stdout = `${stdout}${String(chunk)}`.slice(-64_000))
    child.stderr.on("data", chunk => stderr = `${stderr}${String(chunk)}`.slice(-4_000))
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000)
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) return resolve(stdout)
      const detail = redactCredentialText(stderr.trim())
      reject(new Error(`[vitehub] Browser runtime command failed (${command}, exit ${code ?? "unknown"}): ${detail}`))
    })
  })
}

function installerEnvironment(): NodeJS.ProcessEnv {
  const names = ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "NO_PROXY", "PATH", "SSL_CERT_FILE"]
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
}

async function findChrome(root: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findChrome(path)
      if (nested) return nested
    }
    else if (entry.isFile() && (entry.name === "chrome" || entry.name === "chrome.exe" || entry.name === "Google Chrome for Testing")) return path
  }
}

const extractLinuxChromiumScript = `
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
const require = createRequire(join(process.argv[1], 'package.json'))
const modulePath = require.resolve('@sparticuz/chromium')
const { inflate } = await import(pathToFileURL(modulePath).href)
const bin = join(dirname(modulePath), '..', 'bin')
await Promise.all(['chromium.br', 'al2023.tar.br', 'fonts.tar.br', 'swiftshader.tar.br'].map(name => inflate(join(bin, name))))
await writeFile(join(process.env.TMPDIR, 'fonts', 'fonts.conf'), '<fontconfig><dir prefix="relative">.</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>')
`

// Headless Shell exposes CDP but does not implement Chrome's --dump-dom command.
const smokeLinuxChromiumScript = `
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const profile = await mkdtemp(join(tmpdir(), 'vh-chrome-'))
const child = spawn(process.argv[1], ['--headless', '--disable-dev-shm-usage', '--remote-debugging-port=0', '--user-data-dir=' + profile, ...JSON.parse(process.argv[2]), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium CDP readiness timed out')), 15000)
    let stderr = ''
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Chromium exited: ' + code + ' ' + stderr)) })
    child.stderr.on('data', data => {
      stderr = (stderr + data).slice(-4000)
      if (stderr.includes("DevTools listening on ws://127.0.0.1:")) { clearTimeout(timer); resolve() }
    })
  })
} finally {
  child.kill('SIGKILL')
  await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('close', resolve))
  await rm(profile, { recursive: true, force: true })
}
`

async function smokeChrome(executablePath: string, env: NodeJS.ProcessEnv, preferNoSandbox = false, linuxBundle = false): Promise<string | undefined> {
  if (linuxBundle) {
    await run(process.execPath, ["--input-type=module", "-e", smokeLinuxChromiumScript, executablePath, JSON.stringify(["--no-sandbox"])], { env, timeoutMs: 20_000 })
    return "--no-sandbox"
  }
  if (preferNoSandbox) {
    await run(executablePath, ["--headless", "--disable-gpu", "--no-sandbox", "--dump-dom", "about:blank"], { env, timeoutMs: 20_000 })
    return "--no-sandbox"
  }
  try {
    await run(executablePath, ["--headless", "--disable-gpu", "--dump-dom", "about:blank"], { env, timeoutMs: 20_000 })
    return
  }
  catch (initialError) {
    try {
      await run(executablePath, ["--headless", "--disable-gpu", "--no-sandbox", "--dump-dom", "about:blank"], { env, timeoutMs: 20_000 })
      return "--no-sandbox"
    }
    catch {
      throw initialError
    }
  }
}

async function provision(root: string, npmCommand = "npm", platform: NodeJS.Platform = process.platform): Promise<PreparedBrowserRuntime> {
  if (platform !== "linux" && platform !== "darwin") throw new Error("[vitehub] Managed browser() supports Linux and macOS. Use runtime: external for a prepared browser runtime.")
  if (platform === "linux" && process.arch !== "x64") throw new Error("[vitehub] Managed browser() currently requires Linux x64. Use runtime: external for other architectures.")
  const packageRoot = join(root, "package")
  const binRoot = join(packageRoot, "node_modules", ".bin")
  const command = join(binRoot, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser")
  const browserVersion = platform === "linux" ? chromiumBundleVersion : chromeForTestingVersion
  const socketRoot = join(tmpdir(), `vh-ab-${process.getuid?.() ?? process.pid}`)
  const skillPath = join(root, "core.SKILL.md")
  const marker = join(root, "ready.json")
  const readyRuntime = async (ready: { chrome?: string, noSandbox?: boolean, version?: string, browserVersion?: string, linuxBundle?: boolean }): Promise<PreparedBrowserRuntime | undefined> => {
    if (ready.version !== agentBrowserVersion || ready.browserVersion !== browserVersion || ready.linuxBundle !== (platform === "linux") || !ready.chrome) return
    const executablePath = join(root, ready.chrome)
    if (!(await stat(command).catch(() => undefined))?.isFile() || !(await stat(executablePath).catch(() => undefined))?.isFile()) return
    const browserEnvironment: Record<string, string> = {}
    if (ready.linuxBundle) {
      browserEnvironment.LD_LIBRARY_PATH = join(root, "chromium", "al2023", "lib")
      browserEnvironment.FONTCONFIG_PATH = join(root, "chromium", "fonts")
    }
    const noSandbox = await smokeChrome(executablePath, { ...installerEnvironment(), ...browserEnvironment }, ready.noSandbox, ready.linuxBundle)
    await mkdir(socketRoot, { mode: 0o700, recursive: true })
    const environment: Record<string, string> = {
      ...browserEnvironment,
      AGENT_BROWSER_EXECUTABLE_PATH: executablePath,
      AGENT_BROWSER_SOCKET_DIR: socketRoot,
      PATH: binRoot,
    }
    if (noSandbox) environment.AGENT_BROWSER_ARGS = noSandbox
    return {
      command,
      environment: Object.freeze(environment),
      skillContent: `${await readFile(skillPath, "utf8")}\n## Managed runtime\n\nViteHub has installed the CLI and browser and assigned an isolated session for this invocation. Use \`agent-browser\` directly. Keep the configured \`AGENT_BROWSER_SESSION\`; skip installation and session setup examples in the CLI guide. Do not use \`npx\` or override \`--session\`. ViteHub closes the session when this invocation finishes.\n`,
    }
  }
  let invalidCache = false
  try {
    const prepared = await readyRuntime(JSON.parse(await readFile(marker, "utf8")))
    if (prepared) return prepared
    invalidCache = Boolean(await stat(root).catch(() => undefined))
  }
  catch {
    invalidCache = Boolean(await stat(root).catch(() => undefined))
  }

  const staging = `${root}.install-${process.pid}-${crypto.randomUUID()}`
  await rm(staging, { force: true, recursive: true })
  await mkdir(staging, { recursive: true })
  const stagingPackage = join(staging, "package")
  const stagingBin = join(stagingPackage, "node_modules", ".bin")
  const stagingCommand = join(stagingBin, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser")
  const stagingBrowsersCommand = join(stagingBin, process.platform === "win32" ? "browsers.cmd" : "browsers")
  const stagingBrowserCache = join(staging, "chromium")
  const installEnv = {
    ...installerEnvironment(),
    AGENT_BROWSER_SOCKET_DIR: socketRoot,
  }
  try {
    await mkdir(stagingPackage, { recursive: true })
    const linuxBundle = platform === "linux"
    await run(npmCommand, ["install", "--prefix", stagingPackage, "--no-audit", "--no-fund", "--ignore-scripts", `agent-browser@${agentBrowserVersion}`, linuxBundle ? `@sparticuz/chromium@${chromiumBundleVersion}` : `@puppeteer/browsers@${puppeteerBrowsersVersion}`], { env: installEnv })
    let stagingChrome: string | undefined
    if (linuxBundle) {
      await mkdir(stagingBrowserCache, { recursive: true })
      await run(process.execPath, ["--input-type=module", "-e", extractLinuxChromiumScript, stagingPackage], { env: { ...installEnv, TMPDIR: stagingBrowserCache } })
      stagingChrome = join(stagingBrowserCache, "chromium")
    }
    else {
      await run(stagingBrowsersCommand, ["install", `chrome@${chromeForTestingVersion}`, "--path", stagingBrowserCache], { env: installEnv })
      stagingChrome = await findChrome(stagingBrowserCache)
    }
    if (!stagingChrome) throw new Error("[vitehub] Browser runtime installation did not produce a Chrome executable.")
    const noSandbox = await smokeChrome(stagingChrome, {
      ...installEnv,
      ...(linuxBundle ? { LD_LIBRARY_PATH: join(stagingBrowserCache, "al2023", "lib"), FONTCONFIG_PATH: join(stagingBrowserCache, "fonts") } : {}),
    }, false, linuxBundle)
    const officialSkill = await readFile(join(stagingPackage, "node_modules", "agent-browser", "skills", "agent-browser", "SKILL.md"), "utf8")
    const skillContent = `${officialSkill.replace(/^hidden:\s*true\s*$/m, "").replace(/^Install:.*$/m, "").trim()}\n\n## ViteHub screenshots\n\nSave screenshots under \`screenshots/\`. To attach one to the final reply, add \`![Description](screenshots/name.png)\` on its own line.\n`
    await writeFile(join(staging, "core.SKILL.md"), skillContent)
    const chrome = stagingChrome.slice(staging.length + 1)
    await writeFile(join(staging, "ready.json"), JSON.stringify({ chrome, linuxBundle, noSandbox: Boolean(noSandbox), version: agentBrowserVersion, browserVersion }))
    await mkdir(dirname(root), { recursive: true })
    if (invalidCache) await rm(root, { force: true, recursive: true })
    try {
      await rename(staging, root)
    }
    catch (error) {
      const code = isRuntimeRecord(error) && hasRuntimeType(error.code, "string") ? error.code : undefined
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error
      await rm(staging, { force: true, recursive: true })
      const prepared = await readyRuntime(JSON.parse(await readFile(marker, "utf8")))
      if (!prepared) throw error
      return prepared
    }
    await mkdir(socketRoot, { mode: 0o700, recursive: true })
    const prepared = await readyRuntime({ chrome, linuxBundle, noSandbox: Boolean(noSandbox), version: agentBrowserVersion, browserVersion })
    if (!prepared) throw new Error("[vitehub] Browser runtime cache validation failed after installation.")
    return prepared
  }
  catch (error) {
    await rm(staging, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

export function prepareBrowserRuntime(options: BrowserRuntimePreparationOptions = {}): Promise<PreparedBrowserRuntime> {
  const root = options.cacheRoot || defaultCacheRoot()
  const key = `${root}\0${options.npmCommand || "npm"}\0${options.platform || process.platform}`
  let preparation = preparations.get(key)
  if (!preparation) {
    preparation = provision(root, options.npmCommand, options.platform).catch((error) => {
      preparations.delete(key)
      throw error
    })
    preparations.set(key, preparation)
  }
  return preparation
}

export function resetBrowserRuntimePreparationForTest(): void {
  preparations.clear()
}

export function provideBrowserRuntimeEnvironment(context: AgentInvocationContextStore, environment: Readonly<Record<string, string>>): void {
  context.set(browserRuntimeEnvironmentContextKey, environment, { overwrite: true })
}

export function browserRuntimeEnvironment(context: AgentInvocationContextStore): Readonly<Record<string, string>> | undefined {
  const value = context.get(browserRuntimeEnvironmentContextKey)
  if (!isRuntimeRecord(value) || Object.values(value).some(item => !hasRuntimeType(item, "string"))) return
  // SAFETY: Every own value was parsed as a string at the invocation context boundary.
  return value as Readonly<Record<string, string>>
}

export async function closeBrowserRuntimeSession(environment: Readonly<Record<string, string>>): Promise<void> {
  const binRoot = environment.PATH
  if (!binRoot || !environment.AGENT_BROWSER_SESSION) return
  const command = join(binRoot, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser")
  const installEnvironment = installerEnvironment()
  await run(command, ["close"], {
    env: { ...installEnvironment, ...environment, PATH: `${binRoot}${process.platform === "win32" ? ";" : ":"}${installEnvironment.PATH || ""}` },
    timeoutMs: 15_000,
  }).catch(() => undefined)
}
