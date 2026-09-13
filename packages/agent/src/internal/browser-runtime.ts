import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { lock } from "proper-lockfile"

import type { AgentInvocationContextStore } from "../types.ts"
import { assertTrustedBrowserCache } from "./browser-cache.ts"
import { redactCredentialText } from "./credential-redaction.ts"

const agentBrowserVersion = "0.35.2"
const puppeteerBrowsersVersion = "2.10.10"
const chromiumBundleVersion = "149.0.0"
const chromeForTestingVersion = "149.0.7827.155"
const browserRuntimeEnvironments = new WeakMap<AgentInvocationContextStore, Readonly<Record<string, string>>>()
const socketDirectoryReferences = new Map<string, number>()
const preparations = new Map<string, { controller: AbortController, promise: Promise<PreparedBrowserRuntime>, consumers: number }>()

export interface PreparedBrowserRuntime {
  command: string
  environment: Readonly<Record<string, string>>
  skillContent: string
}

export interface BrowserRuntimePreparationOptions {
  abortSignal?: AbortSignal
  cacheRoot?: string
  npmCommand?: string
  platform?: NodeJS.Platform
}

function defaultCacheRoot(): string {
  const configured = process.env.VITEHUB_CACHE_DIR?.trim()
  const xdg = process.env.XDG_CACHE_HOME?.trim()
  return join(configured || join(xdg || join(homedir(), ".cache"), "vitehub"), "browser", `agent-browser-${agentBrowserVersion}-chromium-${chromiumBundleVersion}-chrome-${chromeForTestingVersion}`)
}

function run(command: string, args: readonly string[], options: { cwd?: string, env: NodeJS.ProcessEnv, timeoutMs?: number, signal?: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => stdout = `${stdout}${String(chunk)}`.slice(-64_000))
    child.stderr.on("data", chunk => stderr = `${stderr}${String(chunk)}`.slice(-4_000))
    let forced = false
    let terminating = false
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      if (forced || terminating || settled) return
      terminating = true
      child.kill("SIGTERM")
      // Linux smoke checks launch Chromium in a detached process group. Kill
      // that group during escalation so the browser cannot outlive the
      // wrapper and keep its profile locked while cleanup is skipped.
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGTERM") } catch { /* already gone */ }
      }
      grace = setTimeout(() => {
        forced = true
        child.kill("SIGKILL")
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, "SIGKILL") } catch { /* already gone */ }
        }
      }, 2_000)
    }
    const abort = terminate
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    const timeout = setTimeout(terminate, options.timeoutMs ?? 120_000)
    child.once("error", (error) => {
      settled = true
      clearTimeout(timeout)
      if (grace) clearTimeout(grace)
      options.signal?.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("close", (code) => {
      settled = true
      clearTimeout(timeout)
      if (grace) clearTimeout(grace)
      options.signal?.removeEventListener("abort", abort)
      if (options.signal?.aborted) return reject(options.signal.reason)
      if (code === 0) return resolve(stdout)
      let detail = redactCredentialText(stderr.trim())
      for (const value of Object.values(options.env)) {
        if (value && /:\/\//.test(value) && /@/.test(value)) detail = detail.split(value).join("[REDACTED]")
      }
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

async function normalizePrivateModes(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await chmod(path, 0o700)
      await normalizePrivateModes(path)
    } else if (entry.isFile()) {
      const mode = (await stat(path)).mode
      await chmod(path, mode & 0o111 ? 0o700 : 0o600)
    }
  }
}

const extractLinuxChromiumScript = `
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
const require = createRequire(join(process.argv[1], 'package.json'))
const modulePath = require.resolve('@sparticuz/chromium')
const Chromium = (await import(pathToFileURL(modulePath).href)).default
await Chromium.executablePath()
await mkdir(join(process.env.TMPDIR, 'fonts'), { recursive: true })
await writeFile(join(process.env.TMPDIR, 'fonts', 'fonts.conf'), '<fontconfig><dir prefix="relative">.</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>')
`

// Headless Shell exposes CDP but does not implement Chrome's --dump-dom command.
const smokeLinuxChromiumScript = `
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const cancellation = new AbortController()
process.on('SIGTERM', () => cancellation.abort(new Error('Chromium smoke check cancelled')))
const profile = await mkdtemp(join(tmpdir(), 'vh-chrome-'))
const child = spawn(process.argv[1], ['--headless', '--disable-dev-shm-usage', '--remote-debugging-port=0', '--user-data-dir=' + profile, ...JSON.parse(process.argv[2]), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
const group = child.pid
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium CDP readiness timed out')), 15000)
    const abort = () => { clearTimeout(timer); reject(cancellation.signal.reason) }
    cancellation.signal.addEventListener('abort', abort, { once: true })
    if (cancellation.signal.aborted) abort()
    let stderr = ''
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Chromium exited: ' + code + ' ' + stderr)) })
    child.stderr.on('data', data => {
      stderr = (stderr + data).slice(-4000)
      if (stderr.includes("DevTools listening on ws://127.0.0.1:")) { clearTimeout(timer); resolve() }
    })
  })
} finally {
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    try { process.kill(child.pid, 'SIGKILL') } catch {}
  }
  await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('close', resolve))
  // A direct-child close does not join helpers with independent stdio.
  // Zombies have exited and released their files; their reaping belongs to
  // the adopting parent, which may be PID 1 rather than this wrapper.
  if (child.pid) {
    const deadline = Date.now() + 1500
    while (true) {
      let running = false
      for (const pid of await readdir('/proc')) {
        if (!/^[0-9]+$/.test(pid)) continue
        const status = await readFile('/proc/' + pid + '/stat', 'utf8').catch(error => {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') return ''
          throw error
        })
        const fields = status.slice(status.lastIndexOf(')') + 2).split(' ')
        if ((Number(fields[1]) === child.pid || Number(fields[2]) === group) && !['Z', 'X'].includes(fields[0])) {
          running = true
          break
        }
      }
      if (!running) break
      if (Date.now() >= deadline) throw new Error('Chromium helpers did not exit; retaining profile ' + profile)
      await delay(10)
    }
  }
  await rm(profile, { recursive: true, force: true })
}
`

async function smokeChrome(executablePath: string, env: NodeJS.ProcessEnv, preferNoSandbox = false, linuxBundle = false, signal?: AbortSignal): Promise<string | undefined> {
  if (linuxBundle) {
    await run(process.execPath, ["--input-type=module", "-e", smokeLinuxChromiumScript, executablePath, JSON.stringify(["--no-sandbox"])], { env, timeoutMs: 20_000, signal })
    return "--no-sandbox"
  }
  if (preferNoSandbox) {
    await run(executablePath, ["--headless", "--disable-gpu", "--no-sandbox", "--dump-dom", "about:blank"], { env, timeoutMs: 20_000, signal })
    return "--no-sandbox"
  }
  try {
    await run(executablePath, ["--headless", "--disable-gpu", "--dump-dom", "about:blank"], { env, timeoutMs: 20_000, signal })
    return
  }
  catch (initialError) {
    signal?.throwIfAborted()
    try {
      await run(executablePath, ["--headless", "--disable-gpu", "--no-sandbox", "--dump-dom", "about:blank"], { env, timeoutMs: 20_000, signal })
      return "--no-sandbox"
    }
    catch {
      throw initialError
    }
  }
}

async function provision(root: string, npmCommand = "npm", platform: NodeJS.Platform = process.platform, signal?: AbortSignal): Promise<PreparedBrowserRuntime> {
  await mkdir(dirname(root), { recursive: true, mode: 0o700 })
  root = join(await realpath(dirname(root)), basename(root))
  await assertTrustedBrowserCache(root)
  let lockError: Error | undefined
  const assertLock = () => {
    if (lockError) throw lockError
  }
  const lockPromise = lock(root, {
    realpath: false,
    retries: { retries: 1, forever: true, minTimeout: 1_000, maxTimeout: 1_000 },
    stale: 60_000,
    update: 10_000,
    onCompromised(error) { lockError = error },
  })
  const abortPromise = signal ? new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error("The operation was aborted"))
    else signal.addEventListener("abort", () => reject(signal.reason ?? new Error("The operation was aborted")), { once: true })
  }) : undefined
  let release: (() => Promise<void>) | undefined
  try {
    release = await (abortPromise ? Promise.race([lockPromise, abortPromise]) : lockPromise)
  }
  catch (error) {
    // The lock acquisition may still complete after cancellation; release it
    // then so abandoned waiters cannot retain the cache lock.
    void lockPromise.then(unlock => unlock()).catch(() => undefined)
    throw error
  }
  if (signal?.aborted) {
    await release()
    throw signal.reason ?? new Error("The operation was aborted")
  }
  try {
    const prepared = await provisionLocked(root, npmCommand, platform, assertLock, signal)
    assertLock()
    return prepared
  }
  finally {
    if (!lockError) await release()
  }
}

async function provisionLocked(root: string, npmCommand: string, platform: NodeJS.Platform, assertLock: () => void, signal?: AbortSignal): Promise<PreparedBrowserRuntime> {
  if (platform !== "linux" && platform !== "darwin") throw new Error("[vitehub] Managed browser() supports Linux and macOS. Use runtime: external for a prepared browser runtime.")
  if (platform === "linux" && process.arch !== "x64") throw new Error("[vitehub] Managed browser() currently requires Linux x64. Use runtime: external for other architectures.")
  await assertTrustedBrowserCache(root)
  const stagingPrefix = `${basename(root)}.install-`
  for (const entry of await readdir(dirname(root))) {
    if (!entry.startsWith(stagingPrefix)) continue
    assertLock()
    const stagingPath = join(dirname(root), entry)
    const stagingStat = await lstat(stagingPath).catch(() => undefined)
    if (!stagingStat || stagingStat.uid !== process.getuid?.() || !stagingStat.isDirectory()) continue
    await rm(stagingPath, { force: true, recursive: true })
  }
  const packageRoot = join(root, "package")
  const binRoot = join(packageRoot, "node_modules", ".bin")
  const command = join(binRoot, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser")
  const browserVersion = platform === "linux" ? chromiumBundleVersion : chromeForTestingVersion
  const socketRoot = await mkdtemp(join(tmpdir(), `vh-ab-${process.getuid?.() ?? process.pid}-`), { encoding: "utf8" })
  await chmod(socketRoot, 0o700)
  // Every ancestor must be owned by the current user and not writable by
  // group/others; otherwise an attacker could replace the validated socket
  // directory between this check and use.
  let ancestor = resolve(socketRoot)
  while (true) {
    const ancestorStat = await lstat(ancestor)
    const mode = ancestorStat.mode & 0o7777
    const isTrustedSystem = ancestorStat.uid === 0 && (((mode & 0o022) === 0) || (mode & 0o1000) !== 0)
    const isPrivateUser = ancestorStat.uid === process.getuid?.() && (mode & 0o022) === 0
    if (!ancestorStat.isDirectory() || (!isTrustedSystem && !isPrivateUser)) {
      await rm(socketRoot, { force: true, recursive: true }).catch(() => undefined)
      throw new Error("[vitehub] Browser socket directory ancestors must be private directory paths or trusted system directories.")
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const socketStat = await lstat(socketRoot)
  if (!socketStat.isDirectory() || socketStat.uid !== process.getuid?.() || (socketStat.mode & 0o077) !== 0) {
    await rm(socketRoot, { force: true, recursive: true }).catch(() => undefined)
    throw new Error("[vitehub] Browser socket directory must be a private directory owned by the current user.")
  }
  const skillPath = join(root, "core.SKILL.md")
  const marker = join(root, "ready.json")
  const readyRuntime = async (ready: { chrome?: string, noSandbox?: boolean, version?: string, browserVersion?: string, linuxBundle?: boolean }): Promise<PreparedBrowserRuntime | undefined> => {
    if (ready.version !== agentBrowserVersion || ready.browserVersion !== browserVersion || ready.linuxBundle !== (platform === "linux") || !ready.chrome) return
    const executablePath = join(root, ready.chrome)
    if (!(await stat(command).catch(() => undefined))?.isFile() || !(await stat(executablePath).catch(() => undefined))?.isFile()) return
    const version = await run(command, ["--version"], { env: installerEnvironment(), timeoutMs: 15_000, signal })
    if (version.trim() !== `agent-browser ${agentBrowserVersion}`) return
    const browserEnvironment: Record<string, string> = {}
    if (ready.linuxBundle) {
      browserEnvironment.LD_LIBRARY_PATH = join(root, "chromium", "al2023", "lib")
      browserEnvironment.FONTCONFIG_PATH = join(root, "chromium", "fonts")
    }
    const noSandbox = await smokeChrome(executablePath, { ...installerEnvironment(), ...browserEnvironment }, ready.noSandbox, ready.linuxBundle, signal)
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
      skillContent: `${await readFile(skillPath, "utf8")}\n## Managed runtime\n\nBefore following any browser instructions, check that \`AGENT_BROWSER_SESSION\` is set. If it is absent, the managed browser capability is inactive: do not run browser commands or installation steps from this Skill. Ask the caller to enable browser() for this Agent. If it is set, ViteHub has prepared the CLI and browser and assigned an isolated session for this invocation. Use \`agent-browser\` directly. Keep the configured \`AGENT_BROWSER_SESSION\`; skip installation and session setup examples in the CLI guide. Do not use \`npx\` or override \`--session\`. ViteHub closes the session when this invocation finishes.\n`,
    }
  }
  try {
    const prepared = await readyRuntime(JSON.parse(await readFile(marker, "utf8")))
    if (prepared) return prepared
  }
  catch {
    signal?.throwIfAborted()
    // Reinstall incomplete or invalid cache contents under the owned root.
  }

  const staging = `${root}.install-${process.pid}-${crypto.randomUUID()}`
  await rm(staging, { force: true, recursive: true })
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const stagingPackage = join(staging, "package")
  const stagingBin = join(stagingPackage, "node_modules", ".bin")
  const stagingCommand = join(stagingBin, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser")
  const stagingBrowsersCommand = join(stagingBin, process.platform === "win32" ? "browsers.cmd" : "browsers")
  const stagingBrowserCache = join(staging, "chromium")
  const installEnv = {
    ...installerEnvironment(),
    AGENT_BROWSER_SOCKET_DIR: socketRoot,
    // npm derives directory modes from its configured/system umask. Keep
    // every staged cache entry private even when the host uses a permissive
    // umask such as 0002.
    npm_config_umask: "077",
  }
  try {
    await mkdir(stagingPackage, { recursive: true, mode: 0o700 })
    const linuxBundle = platform === "linux"
    await run(npmCommand, ["install", "--prefix", stagingPackage, "--no-audit", "--no-fund", "--ignore-scripts", `agent-browser@${agentBrowserVersion}`, linuxBundle ? `@sparticuz/chromium@${chromiumBundleVersion}` : `@puppeteer/browsers@${puppeteerBrowsersVersion}`], { env: installEnv, signal })
    let stagingChrome: string | undefined
    if (linuxBundle) {
      await mkdir(stagingBrowserCache, { recursive: true, mode: 0o700 })
      await run(process.execPath, ["--input-type=module", "-e", extractLinuxChromiumScript, stagingPackage], { env: { ...installEnv, TMPDIR: stagingBrowserCache }, signal })
      stagingChrome = join(stagingBrowserCache, "chromium")
    }
    else {
      await run(stagingBrowsersCommand, ["install", `chrome@${chromeForTestingVersion}`, "--path", stagingBrowserCache], { env: installEnv, signal })
      stagingChrome = await findChrome(stagingBrowserCache)
    }
    if (!stagingChrome) throw new Error("[vitehub] Browser runtime installation did not produce a Chrome executable.")
    await normalizePrivateModes(staging)
    const noSandbox = await smokeChrome(stagingChrome, {
      ...installEnv,
      ...(linuxBundle ? { LD_LIBRARY_PATH: join(stagingBrowserCache, "al2023", "lib"), FONTCONFIG_PATH: join(stagingBrowserCache, "fonts") } : {}),
    }, false, linuxBundle, signal)
    const officialSkill = await readFile(join(stagingPackage, "node_modules", "agent-browser", "skills", "agent-browser", "SKILL.md"), "utf8")
    const skillContent = `${officialSkill.replace(/^hidden:\s*true\s*$/m, "").replace(/^Install:.*$/m, "").trim()}\n\n## ViteHub screenshots\n\nSave screenshots under \`screenshots/\`. To attach one to the final reply, add \`![Description](screenshots/name.png)\` on its own line.\n`
    await writeFile(join(staging, "core.SKILL.md"), skillContent, { mode: 0o600 })
    const chrome = stagingChrome.slice(staging.length + 1)
    await writeFile(join(staging, "ready.json"), JSON.stringify({ chrome, linuxBundle, noSandbox: Boolean(noSandbox), version: agentBrowserVersion, browserVersion }), { mode: 0o600 })
    await mkdir(dirname(root), { recursive: true, mode: 0o700 })
    assertLock()
    // Keep the owned root in place: removing it would let another user claim
    // its name under a sticky shared parent before the next executable use.
    for (const entry of await readdir(root)) {
      assertLock()
      await rm(join(root, entry), { force: true, recursive: true })
    }
    for (const entry of await readdir(staging)) {
      assertLock()
      await rename(join(staging, entry), join(root, entry))
    }
    await rm(staging, { force: true, recursive: true })
    await mkdir(socketRoot, { mode: 0o700, recursive: true })
    const prepared = await readyRuntime({ chrome, linuxBundle, noSandbox: Boolean(noSandbox), version: agentBrowserVersion, browserVersion })
    if (!prepared) throw new Error("[vitehub] Browser runtime cache validation failed after installation.")
    return prepared
  }
  catch (error) {
    await rm(staging, { force: true, recursive: true }).catch(() => undefined)
    // The socket directory is preparation-owned until the environment is
    // handed to an invocation. Remove it when provisioning or validation
    // fails so aborted and cache-repair attempts do not accumulate vh-ab-*.
    await rm(socketRoot, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

export function prepareBrowserRuntime(options: BrowserRuntimePreparationOptions = {}): Promise<PreparedBrowserRuntime> {
  const signal = options.abortSignal
  if (signal?.aborted) return Promise.reject(signal.reason)
  const root = resolve(options.cacheRoot || defaultCacheRoot())
  const key = `${root}\0${options.npmCommand || "npm"}\0${options.platform || process.platform}`
  let preparation = preparations.get(key)
  if (!preparation) {
    const controller = new AbortController()
    const generation = {
      controller,
      promise: provision(root, options.npmCommand, options.platform, controller.signal).catch((error) => {
        if (preparations.get(key) === generation) preparations.delete(key)
        throw error
      }),
      consumers: 0,
    }
    preparations.set(key, generation)
    preparation = generation
  }
  const generation = preparation
  generation.consumers++
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = () => {
      if (finished) return false
      finished = true
      generation.consumers--
      if (generation.consumers === 0 && preparations.get(key) === generation) { preparations.delete(key); generation.controller.abort() }
      signal?.removeEventListener("abort", onAbort)
      return true
    }
    const onAbort = () => {
      if (!finish()) return
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    generation.promise.then((value) => {
      if (finish()) {
        const socketDirectory = value.environment.AGENT_BROWSER_SOCKET_DIR
        if (socketDirectory) socketDirectoryReferences.set(socketDirectory, (socketDirectoryReferences.get(socketDirectory) ?? 0) + 1)
        resolve(value)
      }
    }, (error) => {
      if (finish()) reject(error)
    })
  })
}

export function resetBrowserRuntimePreparationForTest(): void {
  preparations.clear()
  socketDirectoryReferences.clear()
}

export function provideBrowserRuntimeEnvironment(context: AgentInvocationContextStore, environment: Readonly<Record<string, string>>): void {
  browserRuntimeEnvironments.set(context, environment)
}

export function browserRuntimeEnvironment(context: AgentInvocationContextStore): Readonly<Record<string, string>> | undefined {
  return browserRuntimeEnvironments.get(context)
}

export async function closeBrowserRuntimeSession(environment: Readonly<Record<string, string>>): Promise<void> {
  const binRoot = environment.PATH
  if (!binRoot || !environment.AGENT_BROWSER_SESSION) return
  const command = join(binRoot, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser")
  const installEnvironment = installerEnvironment()
  let closed = false
  try {
    await run(command, ["close"], {
      env: { ...installEnvironment, ...environment, PATH: `${binRoot}${process.platform === "win32" ? ";" : ":"}${installEnvironment.PATH || ""}` },
      timeoutMs: 15_000,
    })
    closed = true
  }
  finally {
    const socketDirectory = environment.AGENT_BROWSER_SOCKET_DIR
    if (closed && socketDirectory) {
      const remaining = (socketDirectoryReferences.get(socketDirectory) ?? 1) - 1
      if (remaining > 0) socketDirectoryReferences.set(socketDirectory, remaining)
      else {
        socketDirectoryReferences.delete(socketDirectory)
        await rm(socketDirectory, { force: true, recursive: true })
      }
    }
  }
}
